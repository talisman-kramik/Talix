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
  /** Real office / location name from Eclipse (e.g. "West Philadelphia"). */
  location?: string;
  /** Raw appointment date/time string from Eclipse (e.g. "2026-05-12T10:30:00Z"
   *  or "2026-05-12 10:30:00"). Used for time-based auto-selection on the
   *  Record screen. May be a date-only or a full ISO datetime. */
  appointment_at?: string;
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

  // AMM_* MRNs mean different things across source systems:
  //   - Pennsylvania (Eclipse): they're operational/system rows with no
  //     usable demographics → drop them.
  //   - Baltimore (Micro): every real patient's patient_case_id starts
  //     with AMM_LIVE.* and the rows have real names but null DOB/sex
  //     → must NOT be dropped.
  // We therefore only suppress AMM_* rows when there is also no name on
  // them, which is the signal that distinguishes the PA system rows from
  // real Baltimore patients.
  if (hasSystemMrnPrefix && hasNoName) return true;

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

/**
 * Build a provider id we can later reverse to filter patients by.
 *
 * We prefer `appointment_provider_id` (a stable numeric id Eclipse + Micro
 * both expose) over name-string matching because name fields can differ
 * across source systems by whitespace, casing, or honorifics — and the
 * Eclipse `==` filter is strict.
 *
 * Two formats:
 *   - `eclid:<id>|<encFirst>|<encLast>`  ← preferred (numeric id present)
 *   - `eclname:<encFirst>|<encLast>`     ← fallback when id is missing/0
 *
 * The name is always embedded so the UI can display it without an extra
 * lookup, and so `resolveEncounterProviderId` can map to a pipeline slug.
 */
function makeEclipseProviderId(
  firstName: string,
  lastName: string,
  appointmentProviderId?: unknown,
): string {
  const first = normalizeEclipseNamePart(firstName);
  const last = normalizeEclipseNamePart(lastName);
  const rawId = String(appointmentProviderId ?? "").trim();
  if (rawId && rawId !== "0") {
    return `eclid:${encodeURIComponent(rawId)}|${encodeURIComponent(first)}|${encodeURIComponent(last)}`;
  }
  return `eclname:${encodeURIComponent(first)}|${encodeURIComponent(last)}`;
}

function parseEclipseProviderId(
  providerId: string,
): { id?: string; first: string; last: string } | null {
  if (providerId.startsWith("eclid:")) {
    const raw = providerId.slice("eclid:".length);
    const [idEnc, firstEnc, lastEnc] = raw.split("|");
    const id = decodeURIComponent(idEnc || "").trim();
    const first = decodeURIComponent(firstEnc || "").trim();
    const last = decodeURIComponent(lastEnc || "").trim();
    if (!id && !first && !last) return null;
    return { id: id || undefined, first, last };
  }
  if (providerId.startsWith("eclname:")) {
    const raw = providerId.slice("eclname:".length);
    const [firstEnc, lastEnc] = raw.split("|");
    if (!firstEnc && !lastEnc) return null;
    return {
      first: decodeURIComponent(firstEnc || "").trim(),
      last: decodeURIComponent(lastEnc || "").trim(),
    };
  }
  return null;
}

type EclipseProviderRow = {
  appointment_provider_id?: number | string;
  provider_first_name?: string;
  provider_last_name?: string;
  source_system?: string;
};

/**
 * Supported Eclipse source systems. The mobile app exposes them as
 * human-readable "locations" to clinicians.
 *  - pennsylvania → source_system="Eclipse" (the original PA practices)
 *  - baltimore    → source_system="Micro"   (added 2026-05, Baltimore offices)
 */
export type EclipseLocation = "pennsylvania" | "baltimore";

export const ECLIPSE_LOCATION_TO_SOURCE_SYSTEM: Record<EclipseLocation, string> = {
  pennsylvania: "Eclipse",
  baltimore: "Micro",
};

export const ECLIPSE_LOCATION_LABEL: Record<EclipseLocation, string> = {
  pennsylvania: "Pennsylvania",
  baltimore: "Baltimore",
};

// Provider list changes infrequently (new providers added at human speed,
// not minute-by-minute). 15 minutes keeps the dropdown snappy across screen
// changes without serving stale data for long.
const ECLIPSE_ROWS_TTL_MS = 15 * 60 * 1000; // 15 minutes
// v3: provider ids now embed `appointment_provider_id` when available so
// patient lookups can filter by id instead of brittle name-string matching.
const ECLIPSE_PROVIDERS_CACHE_KEY_PREFIX = "talix.eclipse.providers.v3";

// Cache + in-flight tracker are keyed per location so switching between
// Pennsylvania and Baltimore is instant (each location has its own warm cache).
const eclipseProvidersCache: Map<
  EclipseLocation,
  { providers: ProviderSummary[]; fetchedAt: number }
> = new Map();
const eclipseProvidersInFlight: Map<
  EclipseLocation,
  Promise<ProviderSummary[]>
> = new Map();

function providersCacheKey(location: EclipseLocation): string {
  return `${ECLIPSE_PROVIDERS_CACHE_KEY_PREFIX}.${location}`;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 8000,
  externalSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Chain an externally-supplied signal into the timeout controller so the
  // caller can abort the fetch (e.g. on location switch) without losing the
  // timeout behaviour.
  let onExternalAbort: (() => void) | null = null;
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      onExternalAbort = () => controller.abort();
      externalSignal.addEventListener("abort", onExternalAbort);
    }
  }

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    if (externalSignal && onExternalAbort) {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
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
  options?: { timeoutMs?: number; retries?: number; signal?: AbortSignal },
): Promise<any[]> {
  const timeoutMs = options?.timeoutMs ?? 120000;
  const retries = options?.retries ?? 3;
  const signal = options?.signal;

  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) search.append(k, v);
  const url = `${endpointBase}?${search.toString()}`;

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    // Bail out of the retry loop the moment the caller aborts — don't burn
    // through a fresh fetch + backoff just to hand back the same AbortError.
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    try {
      const res = await fetchWithTimeout(
        url,
        {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        },
        timeoutMs,
        signal,
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Eclipse exec failed (${res.status}) ${body}`.trim());
      }
      const json = await res.json();
      return Array.isArray((json as any)?.data) ? (json as any).data : [];
    } catch (err) {
      lastErr = err;
      const isAbort =
        (err as { name?: string } | null)?.name === "AbortError" ||
        signal?.aborted === true;
      if (isAbort) {
        throw err;
      }
      const delayMs = Math.min(4000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 250);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function loadPersistedEclipseProviders(
  location: EclipseLocation,
): Promise<ProviderSummary[] | null> {
  try {
    const raw = await AsyncStorage.getItem(providersCacheKey(location));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const providers = parsed.filter((p) => p && typeof p.id === "string");
    return providers.length > 0 ? providers : null;
  } catch {
    return null;
  }
}

async function persistEclipseProviders(
  location: EclipseLocation,
  providers: ProviderSummary[],
): Promise<void> {
  try {
    await AsyncStorage.setItem(providersCacheKey(location), JSON.stringify(providers));
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

export const fetchProviders = async (
  location: EclipseLocation = "pennsylvania",
  options?: { signal?: AbortSignal },
): Promise<ProviderSummary[]> => {
  const eclipse = getEclipseConfig();
  if (!eclipse.url || !eclipse.uuid || !eclipse.token) {
    throw new Error("Eclipse provider config missing. Set EXPO_PUBLIC_ECLIPSE_* values.");
  }

  const sourceSystem = ECLIPSE_LOCATION_TO_SOURCE_SYSTEM[location];
  const signal = options?.signal;

  const now = Date.now();
  const cached = eclipseProvidersCache.get(location);
  if (cached && now - cached.fetchedAt < ECLIPSE_ROWS_TTL_MS) return cached.providers;
  // Skip the in-flight dedupe when an external signal is passed — different
  // callers may want to cancel independently, so they each get their own
  // request rather than sharing a promise that someone else can abort.
  if (!signal) {
    const inFlight = eclipseProvidersInFlight.get(location);
    if (inFlight) return inFlight;
  }

  const endpointBase = `${eclipse.url}/api/v1/queries/${eclipse.uuid}/exec`;
  const baseParams: Record<string, string> = {
    "filters[0][name]": "source_system",
    "filters[0][operator]": "==",
    "filters[0][values][0]": sourceSystem,
    "overrides[other][isDistinct]": "1",
    "overrides[fields][0][name]": "appointment_provider_id",
    "overrides[fields][1][name]": "provider_first_name",
    "overrides[fields][2][name]": "provider_last_name",
    "overrides[fields][3][name]": "source_system",
  };

  const promise = (async () => {
    try {
      // Manager spec: no `page` for distinct providers call.
      // Retry same query shape with smaller perPage to reduce 504 risk.
      let rows: EclipseProviderRow[] = [];
      let lastErr: unknown = null;
      for (const perPage of ["5000", "2000", "1000", "500"]) {
        try {
          rows = (await fetchEclipseQueryExecOnce(
            endpointBase,
            eclipse.token,
            { ...baseParams, perPage },
            { timeoutMs: 120000, retries: 3, signal },
          )) as EclipseProviderRow[];
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          // Don't keep trying smaller page sizes after a user-initiated abort —
          // propagate the cancel immediately.
          const isAbort =
            (err as { name?: string } | null)?.name === "AbortError" ||
            signal?.aborted === true;
          if (isAbort) throw err;
        }
      }
      if (lastErr) throw lastErr;

      const providers: ProviderSummary[] = [];
      for (const row of rows) {
        const first = String(row?.provider_first_name ?? "").trim();
        const last = String(row?.provider_last_name ?? "").trim();
        if (!first && !last) continue;
        providers.push({
          id: makeEclipseProviderId(first, last, row?.appointment_provider_id),
          name: `${first} ${last}`.trim(),
          credentials: null,
          specialty: null,
          latest_score: null,
          quality_scores: {},
        });
      }

      const sorted = sortByName(dedupeById(providers));
      eclipseProvidersCache.set(location, { providers: sorted, fetchedAt: Date.now() });
      await persistEclipseProviders(location, sorted);
      return sorted;
    } catch (networkErr) {
      // A user-initiated abort must propagate as-is — don't fall back to a
      // cached list, since the caller is intentionally switching away from
      // this location.
      const isAbort =
        (networkErr as { name?: string } | null)?.name === "AbortError" ||
        signal?.aborted === true;
      if (isAbort) throw networkErr;

      // Otherwise fall back to in-memory stale cache or persisted cache
      // during transient 5xx.
      const stale = eclipseProvidersCache.get(location);
      if (stale?.providers?.length) return stale.providers;
      const persisted = await loadPersistedEclipseProviders(location);
      if (persisted?.length) {
        eclipseProvidersCache.set(location, { providers: persisted, fetchedAt: Date.now() });
        return persisted;
      }
      throw networkErr;
    }
  })().finally(() => {
    if (!signal) {
      eclipseProvidersInFlight.delete(location);
    }
  });

  if (!signal) {
    eclipseProvidersInFlight.set(location, promise);
  }
  return promise;
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
  const mapped = rows.map((row: any) => {
    // Eclipse strings often come padded with whitespace.
    const rawLocation = String(row.location ?? "").trim();
    const rawCostCenter = String(row.cost_center_name ?? "").trim();
    const location = rawLocation || rawCostCenter || undefined;

    // Eclipse exposes the scheduled time under several aliases depending on
    // the underlying query view. Pick whichever is populated.
    const appointmentAtRaw =
      row.appointment_visit_at ||
      row.appointment_datetime ||
      row.appointment_date_at ||
      row.appointment_time ||
      undefined;
    const appointment_at = appointmentAtRaw
      ? String(appointmentAtRaw).trim() || undefined
      : undefined;

    return {
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
      location,
      appointment_at,
    };
  });

  return mapped.filter((patient) => !isLikelyNoisyPatientRow(patient));
}

export const fetchPatientsByProviderDate = async (
  providerId: string,
  appointmentDate: string,
  q = "",
  location: EclipseLocation = "pennsylvania",
): Promise<PatientSearchResult[]> => {
  const eclipse = getEclipseConfig();
  if (!eclipse.url || !eclipse.uuid || !eclipse.token) {
    throw new Error("Eclipse provider config missing. Set EXPO_PUBLIC_ECLIPSE_* values.");
  }

  const parsed = parseEclipseProviderId(providerId);
  if (!parsed) throw new Error("Invalid provider id. Refresh providers and try again.");

  const sourceSystem = ECLIPSE_LOCATION_TO_SOURCE_SYSTEM[location];
  const endpointBase = `${eclipse.url}/api/v1/queries/${eclipse.uuid}/exec`;

  // Common date-range filters reused across all attempt shapes.
  const dateFilters: Record<string, string> = {
    "filters[__d0][name]": "appointment_visit_at",
    "filters[__d0][operator]": ">=",
    "filters[__d0][values][0]": appointmentDate,
    "filters[__d1][name]": "appointment_visit_at",
    "filters[__d1][operator]": "<=",
    "filters[__d1][values][0]": appointmentDate,
  };

  const baseSourceFilter: Record<string, string> = {
    "filters[s0][name]": "source_system",
    "filters[s0][operator]": "==",
    "filters[s0][values][0]": sourceSystem,
  };

  // Strategy:
  //   1. If we have a numeric appointment_provider_id, query the server with it.
  //      Most reliable across both Eclipse (PA) and Micro (Baltimore).
  //   2. If that returns zero, try the name-based filter (provider_first_name +
  //      provider_last_name with `==`). Helps when id is null but names match.
  //   3. If that also returns zero, drop the provider filter entirely, pull the
  //      day's patients for the source_system, and filter client-side by
  //      normalized provider name. This covers cases where Micro stores
  //      provider names with different whitespace / casing / honorifics than
  //      the distinct providers query returns.
  const attempts: Record<string, string>[] = [];

  if (parsed.id) {
    attempts.push({
      ...baseSourceFilter,
      "filters[p0][name]": "appointment_provider_id",
      "filters[p0][operator]": "==",
      "filters[p0][values][0]": parsed.id,
      ...dateFilters,
    });
  }
  if (parsed.first || parsed.last) {
    attempts.push({
      ...baseSourceFilter,
      "filters[pf][name]": "provider_first_name",
      "filters[pf][operator]": "==",
      "filters[pf][values][0]": parsed.first,
      "filters[pl][name]": "provider_last_name",
      "filters[pl][operator]": "==",
      "filters[pl][values][0]": parsed.last,
      ...dateFilters,
    });
  }
  // Last-resort fallback used to scan + filter client-side.
  const dateOnlyParams: Record<string, string> = {
    ...baseSourceFilter,
    ...dateFilters,
  };

  let rows: any[] = [];
  for (const params of attempts) {
    const result = await fetchEclipseQueryExec(endpointBase, eclipse.token, params, {
      perPage: 5000,
      maxPages: 20,
      timeoutMs: 60000,
      retries: 3,
    });
    if (result.length > 0) {
      rows = result;
      break;
    }
  }

  if (rows.length === 0) {
    // Client-side filter fallback. We pull the day's patients for this
    // source_system, then keep rows whose provider matches the selection
    // via id (preferred) or normalized name tokens.
    const dayRows = await fetchEclipseQueryExec(
      endpointBase,
      eclipse.token,
      dateOnlyParams,
      { perPage: 5000, maxPages: 20, timeoutMs: 60000, retries: 3 },
    );

    const targetTokens = normalizeProviderMatch(
      `${parsed.first} ${parsed.last}`,
    )
      .split(" ")
      .filter(Boolean);

    rows = dayRows.filter((row: any) => {
      if (parsed.id) {
        const rowId = String(row?.appointment_provider_id ?? "").trim();
        if (rowId && rowId === parsed.id) return true;
      }
      const rowName = normalizeProviderMatch(
        `${row?.provider_first_name ?? ""} ${row?.provider_last_name ?? ""}`,
      );
      if (!rowName || targetTokens.length === 0) return false;
      const rowTokens = new Set(rowName.split(" ").filter(Boolean));
      return targetTokens.every((tok) => rowTokens.has(tok));
    });
  }

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
  const isEclipseIdEncoded = selectedProviderId.startsWith("eclid:");

  // If already a pipeline/provider API id, use it directly.
  if (!isNameEncoded && !isEclipseNameEncoded && !isEclipseIdEncoded) {
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
  } else if (isEclipseIdEncoded) {
    // eclid:<id>|<first>|<last> — name is still embedded for slug mapping.
    const raw = selectedProviderId.slice("eclid:".length);
    const [, firstEnc, lastEnc] = raw.split("|");
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
