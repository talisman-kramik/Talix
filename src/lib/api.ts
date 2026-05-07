/**
 * API client for AI Scribe FastAPI backend.
 * Typed SDK matching the web app's lib/api.ts interface.
 */

import { getApiUrl, getApiKey } from "../store/settings";
import AsyncStorage from "@react-native-async-storage/async-storage";

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
  appointment_class?: string;
  patient_case_id?: string;
  appointment_id?: string;
  provider_source_id?: string;
}

function isLikelyNoisyPatientRow(patient: PatientSearchResult): boolean {
  const first = String(patient.first_name || "").trim();
  const last = String(patient.last_name || "").trim();
  const mrn = String(patient.mrn || "").trim().toUpperCase();
  const dob = String(patient.date_of_birth || "").trim().toLowerCase();
  const sex = String(patient.sex || "").trim().toLowerCase();

  // Eclipse feed sometimes emits synthetic/system rows (e.g. AMM_LIVE...)
  // without usable demographics. Hide those from patient picker.
  const hasNoName = !first && !last;
  const hasSystemMrnPrefix = mrn.startsWith("AMM_");
  const hasUnknownDemographics =
    (!dob || dob === "unknown" || dob === "n/a") &&
    (!sex || sex === "unknown" || sex === "n/a");

  // Hide AMM_* rows even if names are partially present; these are
  // operational/system entries in the Pennsylvania Eclipse feed.
  if (hasSystemMrnPrefix) return true;

  return hasNoName && hasUnknownDemographics;
}

const DEFAULT_LOCATION = (process.env.EXPO_PUBLIC_AI_SCRIBE_LOCATION ?? "pennsylvania").trim();

function normalizeText(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeProviderMatch(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/^dr\.?\s+/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Provider IDs that should never be sent to the pipeline backend.
// Keep this list minimal — it affects which provider_id is stored on encounters.
const KNOWN_BAD_PIPELINE_PROVIDER_IDS = new Set(["default", "Peter Tatum"]);
const SAFE_PIPELINE_FALLBACK_PROVIDER_ID = "dr_caleb_ademiloye";

function sortByName<T extends { first_name?: string; last_name?: string; name?: string | null; id: string }>(
  items: T[],
): T[] {
  return [...items].sort((a, b) => {
    const aFallbackName = `${a.last_name ?? ""} ${a.first_name ?? ""}`.trim();
    const bFallbackName = `${b.last_name ?? ""} ${b.first_name ?? ""}`.trim();
    const aLabel = normalizeText((a.name ?? aFallbackName) || a.id);
    const bLabel = normalizeText((b.name ?? bFallbackName) || b.id);
    return aLabel.localeCompare(bLabel);
  });
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

function normalizeEclipseNamePart(value: unknown): string {
  return String(value ?? "").trim();
}

function makeEclipseProviderId(firstName: string, lastName: string): string {
  // Encode the provider name directly into the id so we can later fetch patients
  // without any extra server-side mapping/cache.
  const first = normalizeEclipseNamePart(firstName);
  const last = normalizeEclipseNamePart(lastName);
  return `eclname:${encodeURIComponent(first)}|${encodeURIComponent(last)}`;
}

function parseEclipseProviderId(providerId: string): { first: string; last: string } | null {
  if (!providerId.startsWith("eclname:")) return null;
  const raw = providerId.slice("eclname:".length);
  const [firstEnc, lastEnc] = raw.split("|");
  if (!firstEnc && !lastEnc) return null;
  return {
    first: decodeURIComponent(firstEnc || "").trim(),
    last: decodeURIComponent(lastEnc || "").trim(),
  };
}

type EclipseProviderRow = {
  appointment_provider_id?: number | string;
  provider_first_name?: string;
  provider_last_name?: string;
};

const ECLIPSE_ROWS_TTL_MS = 2 * 60 * 1000; // 2 minutes
const ECLIPSE_PROVIDERS_CACHE_KEY = "talix.eclipse.providers.v1";
let eclipseProvidersCache:
  | {
      providers: ProviderSummary[];
      fetchedAt: number;
    }
  | null = null;
let eclipseProvidersInFlight: Promise<ProviderSummary[]> | null = null;

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 8000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchEclipseQueryExec(
  endpointBase: string,
  token: string,
  params: Record<string, string>,
  options?: { perPage?: number; maxPages?: number; timeoutMs?: number; retries?: number },
): Promise<any[]> {
  const perPage = options?.perPage ?? 2000;
  const maxPages = options?.maxPages ?? 20;
  const timeoutMs = options?.timeoutMs ?? 60000;
  const retries = options?.retries ?? 3;

  const allRows: any[] = [];

  for (let page = 1; page <= maxPages; page += 1) {
    const search = new URLSearchParams();
    search.append("perPage", String(perPage));
    search.append("page", String(page));
    for (const [k, v] of Object.entries(params)) search.append(k, v);

    const url = `${endpointBase}?${search.toString()}`;

    let lastErr: unknown = null;
    for (let attempt = 0; attempt < retries; attempt += 1) {
      try {
        const res = await fetchWithTimeout(
          url,
          {
            headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          },
          timeoutMs,
        );
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(`Eclipse exec failed (${res.status}) ${body}`.trim());
        }
        const json = await res.json();
        const rows = Array.isArray((json as any)?.data) ? (json as any).data : [];
        allRows.push(...rows);

        // last page
        if (rows.length < perPage) return allRows;
        break;
      } catch (err) {
        lastErr = err;
        // exponential backoff: 1s, 2s, 4s (+ jitter)
        const delayMs = Math.min(4000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 250);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    if (lastErr) {
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    }
  }

  return allRows;
}

async function fetchEclipseQueryExecOnce(
  endpointBase: string,
  token: string,
  params: Record<string, string>,
  options?: { timeoutMs?: number; retries?: number },
): Promise<any[]> {
  const timeoutMs = options?.timeoutMs ?? 120000;
  const retries = options?.retries ?? 3;

  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) search.append(k, v);
  const url = `${endpointBase}?${search.toString()}`;

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const res = await fetchWithTimeout(
        url,
        {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        },
        timeoutMs,
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Eclipse exec failed (${res.status}) ${body}`.trim());
      }
      const json = await res.json();
      return Array.isArray((json as any)?.data) ? (json as any).data : [];
    } catch (err) {
      lastErr = err;
      const delayMs = Math.min(4000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 250);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function loadPersistedEclipseProviders(): Promise<ProviderSummary[] | null> {
  try {
    const raw = await AsyncStorage.getItem(ECLIPSE_PROVIDERS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const providers = parsed.filter((p) => p && typeof p.id === "string");
    return providers.length > 0 ? providers : null;
  } catch {
    return null;
  }
}

async function persistEclipseProviders(providers: ProviderSummary[]): Promise<void> {
  try {
    await AsyncStorage.setItem(ECLIPSE_PROVIDERS_CACHE_KEY, JSON.stringify(providers));
  } catch {
    // Non-fatal cache write failure.
  }
}

function normalizeProviderName(first: unknown, last: unknown): string {
  return `${String(first || "").trim()} ${String(last || "").trim()}`.trim();
}

function normalizeDateString(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const direct = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (direct) return direct[1];

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function getEclipseProviderKey(row: any): string | null {
  const rawId = String(row?.appointment_provider_id ?? "").trim();
  const fullName = normalizeProviderName(row?.provider_first_name, row?.provider_last_name);

  // Some datasets collapse all providers to id=0. In that case, key by name.
  if (!rawId || rawId === "0") {
    return fullName ? `name:${fullName.toLowerCase()}` : null;
  }
  return rawId;
}

export const fetchProviders = async (): Promise<ProviderSummary[]> => {
  const eclipse = getEclipseConfig();
  if (!eclipse.url || !eclipse.uuid || !eclipse.token) {
    throw new Error("Eclipse provider config missing. Set EXPO_PUBLIC_ECLIPSE_* values.");
  }

  const now = Date.now();
  if (eclipseProvidersCache && now - eclipseProvidersCache.fetchedAt < ECLIPSE_ROWS_TTL_MS) return eclipseProvidersCache.providers;
  if (eclipseProvidersInFlight) return eclipseProvidersInFlight;

  const endpointBase = `${eclipse.url}/api/v1/queries/${eclipse.uuid}/exec`;
  const baseParams: Record<string, string> = {
    "filters[0][name]": "source_system",
    "filters[0][operator]": "==",
    "filters[0][values][0]": "Eclipse",
    "overrides[other][isDistinct]": "1",
    "overrides[fields][0][name]": "appointment_provider_id",
    "overrides[fields][1][name]": "provider_first_name",
    "overrides[fields][2][name]": "provider_last_name",
  };

  eclipseProvidersInFlight = (async () => {
    try {
      // Manager spec: no `page` for distinct providers call.
      // Retry same query shape with smaller perPage to reduce 504 risk.
      let rows: EclipseProviderRow[] = [];
      let lastErr: unknown = null;
      for (const perPage of ["2000", "1000", "500"]) {
        try {
          rows = (await fetchEclipseQueryExecOnce(
            endpointBase,
            eclipse.token,
            { ...baseParams, perPage },
            { timeoutMs: 120000, retries: 3 },
          )) as EclipseProviderRow[];
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
        }
      }
      if (lastErr) throw lastErr;

      const providers: ProviderSummary[] = [];
      for (const row of rows) {
        const first = String(row?.provider_first_name ?? "").trim();
        const last = String(row?.provider_last_name ?? "").trim();
        if (!first && !last) continue;
        providers.push({
          id: makeEclipseProviderId(first, last),
          name: `${first} ${last}`.trim(),
          credentials: null,
          specialty: null,
          latest_score: null,
          quality_scores: {},
        });
      }

      const sorted = sortByName(dedupeById(providers));
      eclipseProvidersCache = { providers: sorted, fetchedAt: Date.now() };
      await persistEclipseProviders(sorted);
      return sorted;
    } catch (networkErr) {
      // Fallback to in-memory stale cache or persisted cache during transient 5xx.
      if (eclipseProvidersCache?.providers?.length) return eclipseProvidersCache.providers;
      const persisted = await loadPersistedEclipseProviders();
      if (persisted?.length) {
        eclipseProvidersCache = { providers: persisted, fetchedAt: Date.now() };
        return persisted;
      }
      throw networkErr;
    }
  })().finally(() => {
    eclipseProvidersInFlight = null;
  });

  return eclipseProvidersInFlight;
};

export const fetchProvider = (id: string) =>
  get<Record<string, unknown>>(`/providers/${id}`);

// ---------------------------------------------------------------------------
// Patients
// ---------------------------------------------------------------------------

export const searchPatients = async (q: string, providerId?: string): Promise<PatientSearchResult[]> => {
  void q;
  void providerId;
  throw new Error("searchPatients is deprecated. Use fetchPatientsByProviderDate(providerId, appointmentDate, q).");
};

function rowMatchesAppointmentDate(row: any, appointmentDate: string): boolean {
  const targetDate = normalizeDateString(appointmentDate);
  if (!targetDate) return true;

  const candidateFields = [
    row?.appointment_date,
    row?.appointment_date_at,
    row?.appointment_datetime,
    row?.date,
    row?.date_of_service,
    row?.dos,
  ];

  const normalizedCandidates = candidateFields
    .map((field) => normalizeDateString(field))
    .filter((value): value is string => Boolean(value));

  // If Eclipse does not provide a usable date in this row,
  // do not exclude it solely because of date filtering.
  if (normalizedCandidates.length === 0) {
    return true;
  }

  return normalizedCandidates.includes(targetDate);
}

function mapEclipsePatientRows(rows: any[]): PatientSearchResult[] {
  const mapped = rows.map((row: any) => ({
    id: String(row.patient_case_id || row.patient_id || Math.random()),
    first_name: (row.first_name || "").trim(),
    last_name: (row.last_name || "").trim(),
    date_of_birth: row.patient_dob_at || "Unknown",
    sex: row.sex || "Unknown",
    mrn: String(row.patient_case_id || row.patient_id || "Unknown"),
    practice_id: "Eclipse",
    appointment_class: row.case_class || row.appointment_status || undefined,
    patient_case_id: String(row.patient_case_id ?? row.patient_id ?? ""),
    appointment_id: String(row.appointment_id ?? row.appt_id ?? row.appointment_no ?? ""),
    provider_source_id: String(row.appointment_provider_id ?? ""),
  }));

  return mapped.filter((patient) => !isLikelyNoisyPatientRow(patient));
}

export const fetchPatientsByProviderDate = async (
  providerId: string,
  appointmentDate: string,
  q = "",
): Promise<PatientSearchResult[]> => {
  const eclipse = getEclipseConfig();
  if (!eclipse.url || !eclipse.uuid || !eclipse.token) {
    throw new Error("Eclipse provider config missing. Set EXPO_PUBLIC_ECLIPSE_* values.");
  }

  const name = parseEclipseProviderId(providerId);
  if (!name) throw new Error("Invalid provider id. Refresh providers and try again.");

  const endpointBase = `${eclipse.url}/api/v1/queries/${eclipse.uuid}/exec`;
  const params: Record<string, string> = {
    "filters[0][name]": "source_system",
    "filters[0][operator]": "==",
    "filters[0][values][0]": "Eclipse",
    "filters[1][name]": "provider_first_name",
    "filters[1][operator]": "==",
    "filters[1][values][0]": name.first,
    "filters[2][name]": "provider_last_name",
    "filters[2][operator]": "==",
    "filters[2][values][0]": name.last,
    "filters[3][name]": "appointment_visit_at",
    "filters[3][operator]": ">=",
    "filters[3][values][0]": appointmentDate,
    "filters[4][name]": "appointment_visit_at",
    "filters[4][operator]": "<=",
    "filters[4][values][0]": appointmentDate,
  };

  const rows = await fetchEclipseQueryExec(endpointBase, eclipse.token, params, {
    perPage: 2000,
    maxPages: 20,
    timeoutMs: 60000,
    retries: 3,
  });

  const mapped = mapEclipsePatientRows(rows);
  if (!q) return sortByName(dedupeById(mapped));

  const query = normalizeText(q);
  const filtered = mapped.filter((r) => {
    const fullName = normalizeText(`${r.first_name} ${r.last_name}`);
    return (
      normalizeText(r.first_name).includes(query) ||
      normalizeText(r.last_name).includes(query) ||
      fullName.includes(query) ||
      normalizeText(r.mrn).includes(query) ||
      normalizeText(r.id).includes(query)
    );
  });
  return sortByName(dedupeById(filtered));
};

// ---------------------------------------------------------------------------
// Encounter creation + upload
// ---------------------------------------------------------------------------

export const createEncounter = (data: {
  encounter_id?: string;
  provider_id: string;
  patient_id: string;
  patient_name?: string;
  visit_type: string;
  mode: string;
  date_of_service?: string;
  created_at?: string;
  audio_file?: string;
  note_audio_file?: string | null;
  has_gold_standard?: boolean;
}) => post<EncounterCreateResponse>("/encounters", data);

export async function resolveEncounterProviderId(
  selectedProviderId: string,
  selectedProviderName?: string | null,
): Promise<string> {
  const isNameEncoded = selectedProviderId.startsWith("name:");
  const isEclipseNameEncoded = selectedProviderId.startsWith("eclname:");

  // If already a pipeline/provider API id, use it directly.
  if (!isNameEncoded && !isEclipseNameEncoded) {
    if (KNOWN_BAD_PIPELINE_PROVIDER_IDS.has(selectedProviderId)) return SAFE_PIPELINE_FALLBACK_PROVIDER_ID;
    return selectedProviderId;
  }

  let nameFromId = selectedProviderId;
  if (isNameEncoded) {
    nameFromId = selectedProviderId.replace(/^name:/, "");
  } else if (isEclipseNameEncoded) {
    // eclname:<first>|<last>
    const raw = selectedProviderId.slice("eclname:".length);
    const [firstEnc, lastEnc] = raw.split("|");
    const first = decodeURIComponent(firstEnc || "").trim();
    const last = decodeURIComponent(lastEnc || "").trim();
    nameFromId = `${first} ${last}`.trim();
  }

  const selectedNorm = normalizeProviderMatch(selectedProviderName || nameFromId);
  const selectedTokens = selectedNorm.split(" ").filter(Boolean);
  const slugCandidate = selectedTokens.length > 0 ? `dr_${selectedTokens.join("_")}` : "";

  try {
    const pipelineProviders = await get<ProviderSummary[]>("/providers");
    if (
      slugCandidate &&
      pipelineProviders.some((p) => p.id === slugCandidate) &&
      !KNOWN_BAD_PIPELINE_PROVIDER_IDS.has(slugCandidate)
    ) {
      return slugCandidate;
    }

    const exact = pipelineProviders.find((p) => normalizeProviderMatch(p.name || p.id) === selectedNorm);
    if (exact && !KNOWN_BAD_PIPELINE_PROVIDER_IDS.has(exact.id)) return exact.id;

    const tokenMatch = pipelineProviders.find((p) => {
      const norm = normalizeProviderMatch(p.name || p.id);
      return selectedTokens.length > 0 && selectedTokens.every((t) => norm.includes(t));
    });
    if (tokenMatch && !KNOWN_BAD_PIPELINE_PROVIDER_IDS.has(tokenMatch.id)) return tokenMatch.id;
  } catch {
    // Fall through and return original id if mapping endpoint is unavailable.
  }

  // Last resort: try deterministic slug used by several provider IDs.
  if (slugCandidate && !KNOWN_BAD_PIPELINE_PROVIDER_IDS.has(slugCandidate)) return slugCandidate;
  return SAFE_PIPELINE_FALLBACK_PROVIDER_ID;
}

export async function uploadEncounterAudio(
  encounterId: string,
  fileUri: string,
  filename = "recording.m4a",
  noteAudioUri?: string | null,
  noteFilename?: string | null,
): Promise<UploadResponse> {
  const base = getApiUrl();
  const form = new FormData();
  form.append("audio", {
    uri: fileUri,
    name: filename,
    type: "audio/m4a",
  } as unknown as Blob);
  if (noteAudioUri) {
    const notePart = {
      uri: noteAudioUri,
      name: noteFilename || "note_audio.m4a",
      type: "audio/m4a",
    } as unknown as Blob;
    // Keep both field names for backend compatibility.
    form.append("note_audio", notePart);
    form.append("note_file", notePart);
  }

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
