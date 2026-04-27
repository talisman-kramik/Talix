/**
 * API client for AI Scribe FastAPI backend.
 * Typed SDK matching the web app's lib/api.ts interface.
 */

import { getApiUrl, getApiKey } from "../store/settings";

// ---------------------------------------------------------------------------
// Types (mirroring web app)
// ---------------------------------------------------------------------------

export interface SampleSummary {
  sample_id: string;
  mode: "dictation" | "ambient";
  physician: string;
  versions: string[];
  latest_version: string | null;
  has_gold: boolean;
  quality: QualityScore | null;
}

export interface SampleDetail extends SampleSummary {
  patient_context: PatientContext | null;
}

export interface QualityScore {
  overall: number | null;
  accuracy: number | null;
  completeness: number | null;
  no_hallucination: number | null;
  structure: number | null;
  language: number | null;
  overlap: string | null;
}

export interface ProviderSummary {
  id: string;
  name: string | null;
  credentials: string | null;
  specialty: string | null;
  latest_score: number | null;
  quality_scores: Record<string, number>;
}

export interface PatientContext {
  patient?: {
    name?: string;
    date_of_birth?: string;
    age?: number;
    sex?: string;
    mrn?: string;
  };
  encounter?: {
    date_of_service?: string;
    visit_type?: string;
    date_of_injury?: string;
    mechanism_of_injury?: string;
  };
  provider?: {
    name?: string;
    credentials?: string;
    specialty?: string;
  };
  facility?: { name?: string; location?: string };
}

export interface PatientSearchResult {
  id: string;
  first_name: string;
  last_name: string;
  date_of_birth: string;
  sex: string;
  mrn: string;
  practice_id: string;
}

export interface EncounterCreateResponse {
  encounter_id: string;
  status: string;
  provider_id: string;
  patient_id: string;
  visit_type: string;
  mode: string;
  message: string | null;
}

export interface UploadResponse {
  encounter_id: string;
  sample_id: string;
  status: string;
  message: string;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/** Common headers sent with every request (bypass tunnel interstitials, etc.) */
const COMMON_HEADERS: Record<string, string> = {
  "Bypass-Tunnel-Reminder": "true",
};

/**
 * Build auth headers for AI Scribe backend calls.
 * Injects `Authorization: Bearer <key>` when AI_SCRIBE_API_KEY is set.
 * Returns an empty object if no key is configured (dev / local environments).
 */
function getAuthHeaders(): Record<string, string> {
  const key = getApiKey();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

async function get<T>(path: string, params?: Record<string, string>): Promise<T> {
  const base = getApiUrl();
  let fullUrl = `${base}${path}`;
  if (params) {
    const qs = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
    fullUrl += `?${qs}`;
  }
  const res = await fetch(fullUrl, { headers: { ...COMMON_HEADERS, ...getAuthHeaders() } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${path} — ${body}`);
  }
  return res.json();
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const base = getApiUrl();
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { ...COMMON_HEADERS, ...getAuthHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: `API ${res.status}` }));
    throw new Error(err.detail || `API ${res.status}: ${path}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Encounters
// ---------------------------------------------------------------------------

export const fetchSamples = (mode?: string) =>
  get<SampleSummary[]>("/encounters", mode ? { mode } : undefined);

export const fetchSample = (id: string) =>
  get<SampleDetail>(`/encounters/${id}`);

export const fetchNote = (id: string, version?: string) =>
  get<{ content: string }>(`/encounters/${id}/note`, version ? { version } : undefined);

export const fetchTranscript = (id: string, version?: string) =>
  get<{ content: string; versions: string[] }>(
    `/encounters/${id}/transcript`,
    version ? { version } : undefined,
  );

export const fetchAudioUrl = (id: string): string => `${getApiUrl()}/encounters/${id}/audio`;

export const fetchGoldNote = (id: string) =>
  get<{ content: string }>(`/encounters/${id}/gold`);

export const fetchSampleQuality = (id: string, version?: string) =>
  get<QualityScore & { sample_id: string }>(
    `/encounters/${id}/quality`,
    version ? { version } : undefined,
  );

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/** First occurrence wins — remote config can ship duplicate YAML ids until server dedupes. */
function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

function getEclipseConfig() {
  return {
    url: process.env.EXPO_PUBLIC_ECLIPSE_API_URL,
    uuid: process.env.EXPO_PUBLIC_ECLIPSE_APPOINTMENTS_QUERY_UUID,
    token: process.env.EXPO_PUBLIC_ECLIPSE_API_TOKEN,
  };
}

export const fetchProviders = async (): Promise<ProviderSummary[]> => {
  const eclipse = getEclipseConfig();
  if (eclipse.url && eclipse.uuid && eclipse.token) {
    try {
      const endpoint = `${eclipse.url}/api/v1/queries/${eclipse.uuid}/exec`;
      const params = new URLSearchParams();
      params.append("filters[0][name]", "source_system");
      params.append("filters[0][operator]", "==");
      params.append("filters[0][values][0]", "Eclipse");
      params.append("perPage", "2000");

      const res = await fetch(`${endpoint}?${params.toString()}`, {
        headers: { Authorization: `Bearer ${eclipse.token}` },
      });
      if (res.ok) {
        const json = await res.json();
        const rows = json.data || [];
        const providersMap = new Map<string, ProviderSummary>();
        for (const row of rows) {
          const pid = row.appointment_provider_id;
          if (!pid) continue;
          if (!providersMap.has(String(pid))) {
            const first = (row.provider_first_name || "").trim();
            const last = (row.provider_last_name || "").trim();
            providersMap.set(String(pid), {
              id: String(pid),
              name: `${first} ${last}`.trim() || `Provider ${pid}`,
              credentials: null,
              specialty: null,
              latest_score: null,
              quality_scores: {}
            });
          }
        }
        return dedupeById(Array.from(providersMap.values()));
      }
    } catch (err) {
      console.warn("Eclipse fetch providers failed, falling back to default.", err);
    }
  }
  return get<ProviderSummary[]>("/providers").then(dedupeById);
};

export const fetchProvider = (id: string) =>
  get<Record<string, unknown>>(`/providers/${id}`);

// ---------------------------------------------------------------------------
// Patients
// ---------------------------------------------------------------------------

export const searchPatients = async (q: string): Promise<PatientSearchResult[]> => {
  const eclipse = getEclipseConfig();
  if (eclipse.url && eclipse.uuid && eclipse.token) {
    try {
      const endpoint = `${eclipse.url}/api/v1/queries/${eclipse.uuid}/exec`;
      const params = new URLSearchParams();
      params.append("filters[0][name]", "source_system");
      params.append("filters[0][operator]", "==");
      params.append("filters[0][values][0]", "Eclipse");
      params.append("perPage", "500");

      const res = await fetch(`${endpoint}?${params.toString()}`, {
        headers: { Authorization: `Bearer ${eclipse.token}` },
      });

      if (res.ok) {
        const json = await res.json();
        const rows = json.data || [];
        let results: PatientSearchResult[] = rows.map((row: any) => ({
          id: String(row.patient_case_id || row.patient_id || Math.random()),
          first_name: (row.first_name || "").trim(),
          last_name: (row.last_name || "").trim(),
          date_of_birth: row.patient_dob_at || "Unknown",
          sex: row.sex || "Unknown",
          mrn: row.patient_case_id || "Unknown",
          practice_id: "Eclipse",
        }));

        if (q) {
          const query = q.toLowerCase();
          results = results.filter(r => 
            r.first_name.toLowerCase().includes(query) || 
            r.last_name.toLowerCase().includes(query) || 
            r.mrn.toLowerCase().includes(query)
          );
        }
        return dedupeById(results).slice(0, 50);
      }
    } catch (err) {
      console.warn("Eclipse search patients failed, falling back.", err);
    }
  }
  return get<PatientSearchResult[]>("/patients/search", { q }).then(dedupeById);
};

// ---------------------------------------------------------------------------
// Encounter creation + upload
// ---------------------------------------------------------------------------

export const createEncounter = (data: {
  provider_id: string;
  patient_id: string;
  visit_type: string;
  mode: string;
}) => post<EncounterCreateResponse>("/encounters", data);

export async function uploadEncounterAudio(
  encounterId: string,
  fileUri: string,
  filename = "recording.m4a",
): Promise<UploadResponse> {
  const base = getApiUrl();
  const form = new FormData();
  form.append("audio", {
    uri: fileUri,
    name: filename,
    type: "audio/m4a",
  } as unknown as Blob);

  // Don't set Content-Type manually — fetch auto-adds the multipart boundary
  const { "Content-Type": _, ...headersWithoutCT } = COMMON_HEADERS;
  const res = await fetch(`${base}/encounters/${encounterId}/upload`, {
    method: "POST",
    body: form,
    headers: { ...headersWithoutCT, ...getAuthHeaders() },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: `Upload failed (${res.status})` }));
    throw new Error(err.detail || `Upload failed (${res.status})`);
  }
  return res.json();
}

export const fetchEncounterStatus = (id: string) =>
  get<{ encounter_id: string; status: string; message: string; sample_id?: string }>(
    `/encounters/${id}/status`,
  );

// ---------------------------------------------------------------------------
// WebSocket URL
// ---------------------------------------------------------------------------

export function getWsUrl(): string {
  return getApiUrl().replace(/^http/, "ws");
}
