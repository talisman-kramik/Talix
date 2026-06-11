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
  /** Eclipse/Micro New vs Repeat flag (`new_repeat_patient`) — drives visit_type
   *  for both Pennsylvania and Baltimore (values "New" / "Repeat"). */
  new_repeat_patient?: string;
  /** Eclipse appointment status (e.g. "Confirmed", "Missed", "Rescheduled").
   *  Used to hide cancelled-type appointments so the list matches the web. */
  appointment_status?: string;
  /** Human-readable case label from Eclipse (e.g. "MD (MVA030925)"). */
  case_name?: string;
  /** SOAP case number from backend (`case_number` / Eclipse `patient_case_id`). */
  case_number?: string;
  patient_case_id?: string;
  /** Eclipse patient account id without case suffix (e.g. `AMM_LIVE.1.218174.0`). */
  patient_id_raw?: string;
  appointment_id?: string;
  provider_source_id?: string;
  guarantor_id?: string;
  /** ISO date of injury / accident from Eclipse (`date_of_injury`). */
  date_of_injury?: string;
  /** Real office / location name from Eclipse (e.g. "West Philadelphia"). */
  location?: string;
  /** SQL/backend provider label (usually "Last, First") when enriched at upload. */
  provider_name?: string;
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

/**
 * Demographics payload included in encounter_details.json on upload.
 * Required for web history display and SFTP workflow.
 */
export interface EncounterDemographics {
  provider_name: string;
  patient_name: string;
  patient_dob: string; // ISO 8601 date: YYYY-MM-DD
  /** Pipeline/rqlite alias (DATE OF BIRTH header reads d_o_b). */
  d_o_b?: string;
  /**
   * Appointment / visit date (YYYY-MM-DD) → SOAP "DATE OF EXAM" and the
   * rqlite encounter appointment_date. Backend reads `date` (or
   * `appointment_date`); without it the note falls back to today.
   */
  date?: string;
  account_number: string;
  case_name: string;
  /** Full case id (may include AMM_LIVE. prefix) — maps to SOAP "CASE NUMBER". */
  case_number?: string;
  /** Injury / accident date — maps to SOAP header D/ACCIDENT. */
  injury_date?: string;
  /** Supervising / rendering physician — maps to SOAP header SUPERVISING PHYSICIAN. */
  supervising_physician?: string;
  /** Web/SFTP alias for supervising_physician. */
  rendering_provider?: string;
  /** Raw Eclipse field names — backend reads these per manager spec. */
  patient_dob_at?: string;
  patient_case_id?: string;
  date_of_injury?: string;
  /** Pipeline/SOAP alias used in encounter_details.json on server. */
  date_of_accident?: string;
  location_name: string;
  system_location: string;
  /** AMM appointment class for backend visit_type routing (not a case code). */
  appointment_class?: string;
  /** Structured Eclipse identifiers — carried so the web record stores the same
   *  identity fields as web-created encounters (guarantor/appointment/case). */
  guarantor_id?: string;
  appointment_id?: string;
  case_id?: string;
  /** Provider-selected clinical-note routing key — a member of the
   *  Allowed_Visit_Type_Set ("initial_evaluation" | "follow_up" | "discharge").
   *  Present when the provider's Visit Type selection is sent with the upload;
   *  the backend re-validates and falls back to new_repeat_patient derivation
   *  when omitted or invalid. */
  visit_type?: string;
}

/**
 * Validate that provider_name contains at least 1 non-whitespace character.
 * Required for SFTP upload workflow to construct the provider folder path.
 */
export function validateProviderName(providerName: string): boolean {
  return providerName.trim().length > 0;
}

/**
 * Normalize Eclipse ID fields to match the web backend exactly.
 *
 * The web backend (now on the Eclipse API for BOTH locations) cleans every ID
 * field — `patient_case_id`, `appointment_provider_id`, `guarantor_id` — by
 * stripping the source-system markers before building `encounter_id`,
 * `account_number`, and `case_number`:
 *   - Baltimore (Micro):   `AMM_LIVE.1.218174.0.Excelsia` → `1.218174.0`
 *   - Pennsylvania (Eclipse): `9936.1.Excelsia`            → `9936.1`
 *                              `Eclipse.132`               → `132`
 *
 * Rules (mirror of the web):
 *   - remove a leading `AMM_LIVE.` (Baltimore) or `Eclipse.` (Pennsylvania)
 *   - remove a trailing `.Excelsia` (both locations)
 * Keeping this identical to the web guarantees mobile/web produce matching ids.
 */
export function normalizeAccountNumber(raw: string | undefined | null): string {
  let value = String(raw ?? "").trim();
  if (!value) return "";
  value = value.replace(/^AMM_LIVE\./i, "");
  value = value.replace(/^Eclipse\./i, "");
  value = value.replace(/\.Excelsia$/i, "");
  return value;
}

/**
 * Resolve the PM account number (RECORD NUMBER) from Eclipse fields.
 * Prefer `patient_id` (account without case suffix) over `patient_case_id`
 * (which includes the `.1` case suffix on Baltimore/Micro rows).
 */
export function resolvePmAccountNumber(
  patient: Pick<PatientSearchResult, "patient_id_raw" | "patient_case_id" | "mrn">,
): string {
  const fromPatientId = String(patient.patient_id_raw || "").trim();
  if (fromPatientId) {
    return normalizeAccountNumber(fromPatientId);
  }

  let acct = normalizeAccountNumber(patient.patient_case_id || patient.mrn);
  const parts = acct.split(".");
  // patient_case_id fallback: drop trailing case segment (1.218174.0.1 → 1.218174.0).
  if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p))) {
    return parts.slice(0, 3).join(".");
  }
  return acct;
}

/** Micro/Baltimore record ids (e.g. `1.218174.0.1`) — not SOAP case codes like `WC122325`. */
export function isRecordStyleCaseId(value: string): boolean {
  return /^\d+\.\d+\.\d+(?:\.\d+)?$/.test(String(value || "").trim());
}

/** Appt class labels — not SOAP case codes (Eclipse sends `follow_up`, etc.). */
const GENERIC_APPOINTMENT_CLASS_LABELS =
  /^(workers?\s*comp(?:ensation)?|auto\s*accident|office\s*visit|follow[\s_-]*up|fu|new\s*patient|physical\s*therapy|initial\s*visit|established\s*patient|consult(?:ation)?)$/i;

/** Normalize Eclipse/AMM labels (`follow_up` → `follow up`). */
export function normalizeAppointmentLabel(value: string): string {
  return String(value || "")
    .trim()
    .replace(/_/g, " ")
    .replace(/\s+/g, " ");
}

export function isGenericAppointmentLabel(value: string): boolean {
  const v = normalizeAppointmentLabel(value);
  return Boolean(v && GENERIC_APPOINTMENT_CLASS_LABELS.test(v));
}

/** SQL `poi.case_name` / PA case labels (e.g. AWC11326, WC122325, MD(MVA051625)). */
export function isLikelyCaseCode(value: string): boolean {
  const v = String(value || "").trim();
  if (!v || isRecordStyleCaseId(v) || isGenericAppointmentLabel(v)) return false;
  if (/^(AWC|WC|PI|MVA|MD)\b/i.test(v)) return true;
  if (/(?:MVA|WC|PI)\s*\(?\d{6}\)?/i.test(v)) return true;
  if (/^[A-Z]{2,5}\d{4,}$/i.test(v)) return true;
  return false;
}

/**
 * New-patient / consult appointment-class keywords. Kept in sync with the web
 * backend `_infer_visit_type` (ai_scribe/shared.py) so mobile and web route
 * the same appointment classes to the same template.
 */
const INITIAL_VISIT_APPOINTMENT_KEYWORDS = [
  "CONSLT", "CONSULT", "CONS/", "CONSU",
  "NEWPAT", "NEWPT", "NEW PT", "NEW PA",
  "INT MVA", "INT WC", "INT PI", "CHIRO INT", "COMAN INIT",
  "ASSUME", "NP ONLY", "NP-SW", "NP/", "-NP",
  "PT INIT", "DIS-NEW", "DSBLTY-NEW", "-NEW", " NEW",
  "COG NEW", "MEND NP", "NC PRIME",
  "TBI EVAL", "REOPEN-NEW", "1ST",
  "ONLYNP", "ONLYIN", "ORTHNEWEST", "CONNP",
];

/**
 * Map an AMM/Eclipse appointment classification to the middleware visit_type.
 * Mirror of the web backend `_infer_visit_type`: new-patient / consult classes
 * → "initial_evaluation", everything else (incl. unknown/empty) → "follow_up".
 */
export function inferVisitTypeFromAppointmentClass(appointmentClass?: string | null): string {
  const appt = String(appointmentClass || "").toUpperCase();
  if (INITIAL_VISIT_APPOINTMENT_KEYWORDS.some((kw) => appt.includes(kw))) {
    return "initial_evaluation";
  }
  return "follow_up";
}

/**
 * Map the Eclipse/Micro `new_repeat_patient` flag (Denis' new Fact Appointment
 * Detail field — populated for BOTH Pennsylvania and Baltimore) to the
 * visit_type used across the app. This is the same source of truth the web app
 * uses, so mobile and web stay in sync:
 *   - "New"    → "initial_evaluation"
 *   - "Repeat" → "follow_up"
 * Returns null when the flag is empty/unknown so callers can fall back.
 */
export function mapNewRepeatPatientToVisitType(
  newRepeatPatient?: string | null,
): string | null {
  const value = String(newRepeatPatient || "").trim().toLowerCase();
  if (value === "new") return "initial_evaluation";
  if (value === "repeat") return "follow_up";
  return null;
}

/**
 * Resolve the visit_type. Prefers the explicit `new_repeat_patient` flag from
 * Eclipse/Micro (the field web uses), so both locations map New/Repeat →
 * initial_evaluation/follow_up identically. Falls back to the prior behaviour
 * only when the flag is missing:
 *   - Pennsylvania (Eclipse) → "default"
 *   - Baltimore (Micro)      → infer from the appointment class
 */
export function resolveVisitType(
  location: EclipseLocation,
  appointmentClass?: string | null,
  newRepeatPatient?: string | null,
): string {
  const fromNewRepeat = mapNewRepeatPatientToVisitType(newRepeatPatient);
  if (fromNewRepeat) return fromNewRepeat;

  if (location === "pennsylvania") return "default";
  return inferVisitTypeFromAppointmentClass(appointmentClass);
}

/**
 * Provider-selectable Visit Type options for the recording screen. The `value`
 * of each option is a member of the Allowed_Visit_Type_Set and maps one-to-one
 * to a middleware `template_routing` key; the `label` is the provider-facing
 * display text. Mirrors the web `visitTypeOptions` list.
 */
export const VISIT_TYPES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "initial_evaluation", label: "Initial" },
  { value: "follow_up", label: "Follow-Up" },
  { value: "discharge", label: "Discharge" },
];

/**
 * Derive the Default_Visit_Type pre-selected in the Visit Type selector from the
 * Eclipse/Micro `new_repeat_patient` flag, using the same mapping the backend
 * uses for fallback derivation so web and mobile stay in sync:
 *   - "new" (trimmed, case-insensitive) → "initial_evaluation"
 *   - any other value (incl. "Repeat", empty, null/undefined) → "follow_up"
 * Never returns "discharge" — that option is reached only by explicit selection.
 */
export function deriveDefaultVisitType(newRepeatPatient?: string | null): string {
  return String(newRepeatPatient ?? "").trim().toLowerCase() === "new"
    ? "initial_evaluation"
    : "follow_up";
}

/**
 * Patient name in web/EHR "LASTNAME, FIRSTNAME" convention, built from the
 * separate Eclipse first/last fields. Used for encounter_details.patient_name
 * so mobile and web show the same name in history.
 */
export function formatPatientNameLastFirst(first?: string | null, last?: string | null): string {
  const f = String(first || "").trim();
  const l = String(last || "").trim();
  if (f && l) return `${l}, ${f}`;
  return l || f;
}

/**
 * Web/SFTP provider format: "Last, First". Eclipse picker uses "First Last".
 */
export function formatProviderNameLastFirst(name: string): string {
  const trimmed = String(name || "").trim();
  if (!trimmed) return "";
  if (trimmed.includes(",")) return trimmed;
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return trimmed;
  const last = parts[parts.length - 1];
  const first = parts.slice(0, -1).join(" ");
  return `${last}, ${first}`;
}

/**
 * Provider display format used by the web app: "First Last" (e.g. "Scott Pello").
 * Converts a "Last, First" label back to "First Last"; leaves an already
 * first-last name untouched.
 */
export function formatProviderNameFirstLast(name: string): string {
  const trimmed = String(name || "").trim();
  if (!trimmed) return "";
  if (trimmed.includes(",")) {
    const [last, ...rest] = trimmed.split(",");
    const first = rest.join(",").trim();
    const lastName = last.trim();
    if (first && lastName) return `${first} ${lastName}`;
    return first || lastName;
  }
  return trimmed;
}

/**
 * Resolve SOAP CASE NUMBER from Eclipse.
 * WC-style codes (e.g. "WC122325", "MD (WC010214)") live in `case_name` for
 * Pennsylvania. Baltimore/Micro rows have `case_name: null` — WC codes are not
 * in Eclipse for those patients (web gets them from SQL). Never use
 * `patient_case_id` here — that is a record id like 1.218174.0.1, not a case code.
 */
export function resolveCaseNumber(
  patient: Pick<PatientSearchResult, "case_name" | "appointment_class" | "case_number">,
): string {
  const caseNumberField = String(patient.case_number || "").trim();
  if (caseNumberField && !isRecordStyleCaseId(caseNumberField)) return caseNumberField;
  const caseNameField = String(patient.case_name || "").trim();
  if (caseNameField && isLikelyCaseCode(caseNameField)) return caseNameField;
  return "";
}

/** Extract numeric Eclipse `appointment_provider_id` from encoded provider picker id. */
export function resolveBackendProviderId(providerId: string): number | null {
  const trimmed = String(providerId || "").trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("eclid:")) {
    const raw = trimmed.slice("eclid:".length);
    const [idEnc] = raw.split("|");
    const id = Number.parseInt(decodeURIComponent(idEnc || ""), 10);
    return Number.isFinite(id) ? id : null;
  }

  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }

  return null;
}

/**
 * Normalise DOB / injury dates to `YYYY-MM-DD`. Returns empty string when
 * the source is missing or unusable (never sends "Unknown").
 */
export function normalizePatientDob(value: string | undefined | null): string {
  const raw = String(value ?? "").trim();
  if (!raw || raw.toLowerCase() === "unknown" || raw.toLowerCase() === "n/a") return "";
  const direct = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (direct) return direct[1];
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toISOString().slice(0, 10);
}

/** DOB from Eclipse/Micro row — tries all known field aliases (PA + Baltimore). */
export function resolveEclipsePatientDob(row: Record<string, unknown>): string {
  for (const key of [
    "patient_dob_at",
    "patient_dob",
    "date_of_birth",
    "dob",
    "patient_date_of_birth",
  ]) {
    const normalized = normalizePatientDob(row[key] as string | undefined | null);
    if (normalized) return normalized;
  }
  return "";
}

/** Numeric provider id on the appointment row (`appointment_provider_id`). */
export function resolveEclipseAppointmentProviderId(row: Record<string, unknown>): string {
  for (const key of ["appointment_provider_id", "provider_id"]) {
    const value = String(row[key] ?? "").trim();
    if (value && value !== "0") return value;
  }
  return "";
}

/**
 * Pennsylvania Eclipse rows may include `date_of_injury` directly. When it is
 * null, the accident date is sometimes encoded in case_name (MVA/WC/PI + MMDDYY).
 */
export function parseInjuryDateFromCaseLabel(
  caseLabel: string | undefined | null,
): string {
  const raw = String(caseLabel ?? "").trim();
  if (!raw) return "";

  const match = raw.match(/(?:MVA|WC|PI)\s*\(?(\d{2})(\d{2})(\d{2})\)?/i);
  if (!match) return "";

  const [, mm, dd, yy] = match;
  const month = Number(mm);
  const day = Number(dd);
  if (month < 1 || month > 12 || day < 1 || day > 31) return "";

  const yearNum = Number(yy);
  const year = yearNum >= 70 ? 1900 + yearNum : 2000 + yearNum;
  return `${year}-${mm}-${dd}`;
}

/** Resolve D/ACCIDENT — prefer Eclipse `date_of_injury`, else parse PA case code. */
export function resolveInjuryDate(
  patient: Pick<PatientSearchResult, "date_of_injury" | "case_name" | "case_number">,
): string {
  const fromEclipse = normalizePatientDob(patient.date_of_injury);
  if (fromEclipse) return fromEclipse;
  return parseInjuryDateFromCaseLabel(patient.case_name || patient.case_number);
}

/**
 * Human-readable case label for encounter_details.case_name.
 * Do not fall back to appointment_class — SOAP CASE NUMBER uses case_name when
 * case_number is empty, and "Workers Compensation" is not a case code.
 */
export function resolvePatientCaseName(
  patient: Pick<PatientSearchResult, "case_name" | "appointment_class">,
): string {
  const caseName = String(patient.case_name || "").trim();
  if (caseName) return caseName;
  const apptClass = String(patient.appointment_class || "").trim();
  if (apptClass && !isGenericAppointmentLabel(apptClass)) return apptClass;
  return "";
}

/**
 * Build the encounter_details demographics payload from available data.
 * Core fields default to empty string; optional SOAP header fields are omitted when blank.
 */
export function buildEncounterDetails(params: {
  providerName: string;
  patientName: string;
  patientDob: string;
  /** Appointment / visit date (YYYY-MM-DD) → SOAP "DATE OF EXAM". */
  date?: string;
  accountNumber?: string;
  caseName?: string;
  caseNumber?: string;
  injuryDate?: string;
  supervisingPhysician?: string;
  locationName?: string;
  systemLocation?: string;
  appointmentClass?: string;
  /** Raw Eclipse keys (manager spec). */
  patientDobAt?: string;
  patientCaseId?: string;
  dateOfInjury?: string;
  /** Structured Eclipse identifiers — forwarded to the web record. */
  guarantorId?: string;
  appointmentId?: string;
  caseId?: string;
  /** Provider-selected Visit Type (member of the Allowed_Visit_Type_Set). Set on
   *  the payload as `visit_type` only when provided and non-empty. */
  visitType?: string;
}): EncounterDemographics {
  const payload: EncounterDemographics = {
    provider_name: params.providerName,
    patient_name: params.patientName,
    patient_dob: params.patientDob,
    account_number: params.accountNumber ?? "",
    case_name: params.caseName ?? "",
    location_name: params.locationName ?? "",
    system_location: params.systemLocation ?? "",
  };
  const visitDate = String(params.date ?? "").trim();
  if (visitDate) payload.date = visitDate;
  const appointmentClass = String(params.appointmentClass ?? "").trim();
  // Only send non-generic classes — backend/SOAP must not treat "follow_up" as CASE NUMBER.
  if (appointmentClass && !isGenericAppointmentLabel(appointmentClass)) {
    payload.appointment_class = appointmentClass;
  }
  const caseNumber = String(params.caseNumber ?? "").trim();
  const injuryDate = String(params.injuryDate ?? "").trim();
  const supervising = String(params.supervisingPhysician ?? "").trim();
  const dob =
    String(params.patientDob ?? "").trim() || String(params.patientDobAt ?? "").trim();
  const patientDobAt = String(params.patientDobAt ?? "").trim() || dob;
  const patientCaseId = String(params.patientCaseId ?? "").trim();
  const dateOfInjury =
    String(params.dateOfInjury ?? "").trim() || injuryDate;
  if (caseNumber) payload.case_number = caseNumber;
  if (injuryDate) {
    payload.injury_date = injuryDate;
    payload.date_of_injury = injuryDate;
    payload.date_of_accident = injuryDate;
  }
  if (supervising) {
    payload.supervising_physician = supervising;
    payload.rendering_provider = supervising;
  }
  if (dob) {
    payload.patient_dob = dob;
    payload.d_o_b = dob;
    payload.patient_dob_at = patientDobAt || dob;
  }
  if (patientCaseId) payload.patient_case_id = patientCaseId;
  if (dateOfInjury && !injuryDate) {
    payload.date_of_injury = dateOfInjury;
    payload.date_of_accident = dateOfInjury;
    payload.injury_date = dateOfInjury;
  }
  const guarantorId = String(params.guarantorId ?? "").trim();
  const appointmentId = String(params.appointmentId ?? "").trim();
  const caseId = String(params.caseId ?? "").trim();
  if (guarantorId) payload.guarantor_id = guarantorId;
  if (appointmentId) payload.appointment_id = appointmentId;
  if (caseId) payload.case_id = caseId;
  const visitType = String(params.visitType ?? "").trim();
  if (visitType) payload.visit_type = visitType;
  return payload;
}

/**
 * Build encounter_details from a selected patient row + provider context.
 * Mirrors the web AI Scribe demographic mapping.
 */
export function buildEncounterDetailsFromPatient(params: {
  patient: PatientSearchResult;
  providerName: string;
  systemLocation: EclipseLocation;
  /** Selected visit/appointment date (YYYY-MM-DD). Falls back to the patient's
   *  Eclipse appointment date when omitted. */
  date?: string;
  /** Provider-selected Visit Type (member of the Allowed_Visit_Type_Set).
   *  Forwarded onto the demographics payload when provided. */
  visitType?: string;
}): EncounterDemographics {
  const { patient, providerName, systemLocation } = params;
  // Prefer the explicitly selected visit date; fall back to the patient's raw
  // Eclipse appointment datetime (date portion only).
  const visitDate =
    String(params.date ?? "").trim() ||
    String(patient.appointment_at ?? "").split(/[T ]/)[0].trim();
  // "LASTNAME, FIRSTNAME" to match the web/EHR history convention.
  const patientName =
    formatPatientNameLastFirst(patient.first_name, patient.last_name) ||
    patient.mrn ||
    patient.id;
  // Provider names follow the web display convention: "First Last" (e.g.
  // "Scott Pello"), NOT "Last, First". (Patient names stay "Last, First".)
  const supervisingRaw = String(patient.provider_name || providerName).trim() || providerName;
  const supervising = formatProviderNameFirstLast(supervisingRaw);
  const formattedProvider = formatProviderNameFirstLast(providerName);
  const injuryDate = resolveInjuryDate(patient);
  const normalizedDob = normalizePatientDob(patient.date_of_birth);
  const caseCode = resolveCaseNumber(patient);
  // Web history / rqlite persist `case_name` only (not case_number) — store the WC code there.
  const caseNameForSoap =
    caseCode ||
    (isLikelyCaseCode(resolvePatientCaseName(patient))
      ? resolvePatientCaseName(patient)
      : "");

  return buildEncounterDetails({
    providerName: formattedProvider || supervising,
    patientName,
    patientDob: normalizedDob,
    date: visitDate,
    accountNumber: resolvePmAccountNumber(patient),
    caseName: caseNameForSoap,
    caseNumber: caseCode,
    injuryDate,
    supervisingPhysician: supervising,
    locationName:
      String(patient.location || "").trim() || ECLIPSE_LOCATION_LABEL[systemLocation],
    systemLocation,
    appointmentClass: String(patient.appointment_class || "").trim() || undefined,
    patientDobAt: normalizedDob,
    patientCaseId: normalizeAccountNumber(patient.patient_case_id || patient.mrn),
    dateOfInjury: injuryDate,
    // Structured identifiers (so the web record stores the same identity fields
    // as web-created encounters). case_id mirrors the encounter_id case segment.
    guarantorId: String(patient.guarantor_id || "").trim(),
    appointmentId: String(patient.appointment_id || "").trim(),
    caseId: normalizeAccountNumber(patient.patient_case_id || patient.mrn),
    visitType: params.visitType,
  });
}

/** Clean an encounter-id segment: trim + remove internal whitespace; keep `.`/`-`. */
function cleanEncounterIdSegment(value: unknown): string {
  return String(value ?? "").trim().replace(/\s+/g, "");
}

/**
 * Resolve the client encounter_id using the canonical EHR composite:
 *   {patient_case_id}_{appointment_id}_{provider_id}_{YYYYMMDD}
 *
 * Each segment is trimmed (internal spaces removed, `.`/`-` kept), the date is
 * reduced to YYYYMMDD, and a trailing `_YYYYMMDD` already on the appointment id
 * is stripped first. Every id segment is run through `normalizeAccountNumber` so
 * Baltimore's `AMM_LIVE.` prefix — which appears on both the patient id
 * (`AMM_LIVE.1.84915.0.2`) and the provider id (`AMM_LIVE.146`) and contains an
 * underscore that would corrupt the `_`-delimited id — is removed; this is a
 * no-op for Pennsylvania.
 *
 * Linking note:
 * - Pennsylvania: mobile and web both read from Eclipse, so the composite
 *   produces the *same* id on both sides and links correctly.
 * - Baltimore: web reads from SQL with different id values (e.g. patient `84915`
 *   vs Eclipse `AMM_LIVE.1.84915.0.2`, appointment `119902` vs `40709553`), so
 *   this composite will NOT match web until the backend reconciles the two id
 *   namespaces. The format is still emitted for consistency / future linking.
 */
export function resolveClientEncounterId(params: {
  appointmentId?: string | null;
  patientCaseId?: string | null;
  providerId?: string | null;
  dateOfService?: string | null;
  location?: EclipseLocation;
}): string {
  const datePart = cleanEncounterIdSegment(params.dateOfService).replace(/-/g, "");

  let appointment = cleanEncounterIdSegment(normalizeAccountNumber(params.appointmentId));
  if (datePart) {
    const suffix = `_${datePart}`;
    if (appointment.endsWith(suffix)) {
      appointment = appointment.slice(0, -suffix.length);
    }
  }

  const patientCase = cleanEncounterIdSegment(normalizeAccountNumber(params.patientCaseId));
  const provider = cleanEncounterIdSegment(normalizeAccountNumber(params.providerId));

  return [
    patientCase || "unknown",
    appointment || "unknown",
    provider || "unknown",
    datePart || "unknown",
  ].join("_");
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

/**
 * Appointment statuses the web schedule excludes from the patient list. These
 * represent appointments that won't happen (cancelled, missed, moved), so the
 * web's "original list" never shows them. Keeping mobile in sync means hiding
 * the same set; any other status (Confirmed, Arrived, Seen, …) is kept.
 */
const EXCLUDED_APPOINTMENT_STATUSES = new Set([
  "cancelled",
  "canceled",
  "missed",
  "rescheduled",
  "no show",
  "no-show",
  "noshow",
]);

export function isExcludedAppointmentStatus(status?: string | null): boolean {
  return EXCLUDED_APPOINTMENT_STATUSES.has(String(status || "").trim().toLowerCase());
}

/**
 * De-duplicate Eclipse appointment rows down to one entry per patient (matching
 * the web list). Eclipse/Micro can return several rows for the same patient on
 * the same day — e.g. one row tied to a real case and a second with no case.
 * We key by the patient account (without case suffix) and prefer the row that
 * carries a case name, preserving the first-seen order otherwise.
 */
export function dedupePatientsPreferCase(
  items: PatientSearchResult[],
): PatientSearchResult[] {
  const byKey = new Map<string, PatientSearchResult>();
  const order: string[] = [];
  let uniqueCounter = 0;

  for (const item of items) {
    const key = String(item.patient_id_raw || item.patient_case_id || item.id || "")
      .trim()
      .toLowerCase();
    if (!key) {
      const uniqKey = `__uniq_${uniqueCounter++}`;
      byKey.set(uniqKey, item);
      order.push(uniqKey);
      continue;
    }
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, item);
      order.push(key);
      continue;
    }
    // Keep the row that has a case name when the existing one lacks it.
    const existingHasCase = String(existing.case_name || "").trim().length > 0;
    const currentHasCase = String(item.case_name || "").trim().length > 0;
    if (!existingHasCase && currentHasCase) {
      byKey.set(key, item);
    }
  }

  return order.map((k) => byKey.get(k)).filter((v): v is PatientSearchResult => !!v);
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
// not minute-by-minute). 24 h matches the providers-store freshness window
// so we don't pay a 6–16 s foreground Eclipse round-trip every time the
// user resumes the app from a coffee break. Truly fresh data still arrives
// via the next loadProviders() call after 24 h, and any force=true call
// (pull-to-refresh) bypasses this entirely.
const ECLIPSE_ROWS_TTL_MS = 24 * 60 * 60 * 1000;
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
  const signal = options?.signal;

  const now = Date.now();
  const cached = eclipseProvidersCache.get(location);
  if (cached && now - cached.fetchedAt < ECLIPSE_ROWS_TTL_MS) return cached.providers;
  if (!signal) {
    const inFlight = eclipseProvidersInFlight.get(location);
    if (inFlight) return inFlight;
  }

  const promise = (async () => {
    return fetchEclipseProvidersDirect(location, signal);
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

async function fetchEclipseProvidersDirect(
  location: EclipseLocation,
  signal?: AbortSignal,
): Promise<ProviderSummary[]> {
  const eclipse = getEclipseConfig();
  if (!eclipse.url || !eclipse.uuid || !eclipse.token) {
    throw new Error("Eclipse provider config missing. Set EXPO_PUBLIC_ECLIPSE_* values.");
  }

  const sourceSystem = ECLIPSE_LOCATION_TO_SOURCE_SYSTEM[location];
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

  try {
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
    const isAbort =
      (networkErr as { name?: string } | null)?.name === "AbortError" ||
      signal?.aborted === true;
    if (isAbort) throw networkErr;

    const stale = eclipseProvidersCache.get(location);
    if (stale?.providers?.length) return stale.providers;
    const persisted = await loadPersistedEclipseProviders(location);
    if (persisted?.length) {
      eclipseProvidersCache.set(location, { providers: persisted, fetchedAt: Date.now() });
      return persisted;
    }
    throw networkErr;
  }
}

export const fetchProvider = (id: string) =>
  get<Record<string, unknown>>(`/providers/${id}`);

export type CaseNumberUploadVerdict = "real" | "generic" | "empty";

/** Classify what SOAP will treat as CASE NUMBER from the upload payload. */
export function classifyCaseNumberForUpload(value: string): CaseNumberUploadVerdict {
  const v = String(value || "").trim();
  if (!v) return "empty";
  if (isGenericAppointmentLabel(v) || /^follow[_\s-]*up$/i.test(v)) return "generic";
  if (isRecordStyleCaseId(v)) return "empty";
  if (isLikelyCaseCode(v)) return "real";
  return "real";
}

/**
 * Human-readable pre-upload debug text (EXPO_PUBLIC_DEBUG_DEMOGRAPHICS=1).
 * Highlights Baltimore case_number vs follow_up.
 */
export function formatEncounterDetailsDebugMessage(params: {
  demographics: EncounterDemographics;
  patient: PatientSearchResult;
  systemLocation: EclipseLocation;
}): string {
  const { demographics, patient, systemLocation } = params;
  const uploadCase = String(
    demographics.case_number || demographics.case_name || "",
  ).trim();
  const verdict = classifyCaseNumberForUpload(uploadCase);
  const verdictLabel =
    verdict === "real"
      ? "REAL case code"
      : verdict === "generic"
        ? "follow_up / generic (wrong for SOAP)"
        : "EMPTY (no case code in Eclipse row)";

  const lines = [
    `Location: ${systemLocation}`,
    "",
    "DATE OF EXAM (visit date)",
    `  date: ${demographics.date ?? "(empty — falls back to today)"}`,
    "",
    "CASE NUMBER (what upload sends)",
    `  case_number: ${demographics.case_number ?? "(empty)"}`,
    `  case_name: ${demographics.case_name ?? "(empty)"}`,
    `  >>> ${verdictLabel}`,
  ];

  lines.push(
    "",
    "Eclipse row",
    `  appointment_provider_id: ${patient.provider_source_id ?? "(none)"}`,
    `  date_of_birth: ${patient.date_of_birth ?? "(empty)"}`,
    `  case_name: ${patient.case_name ?? "(none)"}`,
    `  case_number: ${patient.case_number ?? "(none)"}`,
    `  appt class: ${patient.appointment_class ?? "(none)"}`,
    `  appointment_class in JSON: ${demographics.appointment_class ?? "(omitted — good)"}`,
  );

  lines.push(
    "",
    "D/ACCIDENT",
    `  injury_date: ${demographics.injury_date ?? "(empty)"}`,
    `  date_of_injury: ${demographics.date_of_injury ?? "(empty)"}`,
    "",
    "DOB (upload)",
    `  d_o_b: ${demographics.d_o_b ?? demographics.patient_dob ?? "(empty)"}`,
  );

  return lines.join("\n");
}

function filterPatientsByQuery(
  patients: PatientSearchResult[],
  q: string,
): PatientSearchResult[] {
  if (!q) return patients;
  const query = normalizeText(q);
  return patients.filter((r) => {
    const fullName = normalizeText(`${r.first_name} ${r.last_name}`);
    return (
      normalizeText(r.first_name).includes(query) ||
      normalizeText(r.last_name).includes(query) ||
      fullName.includes(query) ||
      normalizeText(r.mrn).includes(query) ||
      normalizeText(r.id).includes(query) ||
      normalizeText(r.case_number || "").includes(query)
    );
  });
}

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
      date_of_birth: resolveEclipsePatientDob(row),
      sex: row.sex ? String(row.sex).trim() : "",
      mrn: String(row.patient_case_id || row.patient_id || ""),
      practice_id: "Eclipse",
      appointment_class: row.case_class || row.appointment_status || undefined,
      new_repeat_patient:
        String(row.new_repeat_patient ?? row.new_repeat ?? "").trim() || undefined,
      appointment_status: String(row.appointment_status ?? "").trim() || undefined,
      case_name: (row.case_name || "").trim() || undefined,
      // WC codes are not in Micro/Eclipse — only set when case_name is present (PA).
      case_number: (row.case_name || "").trim() || undefined,
      patient_case_id: String(row.patient_case_id ?? row.patient_id ?? ""),
      patient_id_raw: row.patient_id ? String(row.patient_id).trim() : undefined,
      appointment_id: String(row.appointment_id ?? row.appt_id ?? row.appointment_no ?? ""),
      provider_source_id: resolveEclipseAppointmentProviderId(row),
      guarantor_id: row.guarantor_id ? String(row.guarantor_id).trim() : undefined,
      date_of_injury: row.date_of_injury ? String(row.date_of_injury).trim() : undefined,
      location,
      appointment_at,
    };
  });

  return mapped.filter(
    (patient) =>
      !isLikelyNoisyPatientRow(patient) &&
      !isExcludedAppointmentStatus(patient.appointment_status),
  );
}

export const fetchPatientsByProviderDate = async (
  providerId: string,
  appointmentDate: string,
  q = "",
  location: EclipseLocation = "pennsylvania",
): Promise<PatientSearchResult[]> => {
  return fetchEclipsePatientsByProviderDate(providerId, appointmentDate, q, location);
};

async function fetchEclipsePatientsByProviderDate(
  providerId: string,
  appointmentDate: string,
  q = "",
  location: EclipseLocation = "pennsylvania",
): Promise<PatientSearchResult[]> {
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
  if (!q) return sortByName(dedupePatientsPreferCase(mapped));

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
  return sortByName(dedupePatientsPreferCase(filtered));
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
  demographics?: EncounterDemographics,
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

  // Include demographics in encounter_details form field if provided
  if (demographics) {
    if (!validateProviderName(demographics.provider_name)) {
      throw new Error("provider_name must contain at least 1 non-whitespace character");
    }
    form.append("encounter_details", JSON.stringify(demographics));
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
// Web-Status
// ---------------------------------------------------------------------------

export interface WebStatus {
  status: string;
  edited_at: string;
  edited_by: string;
  soap_version: number;
}

/**
 * Fetch the web-status for an encounter from the Pipeline_Server.
 * Returns null on 404 (no web edits). Throws on network error/timeout.
 */
export async function fetchWebStatus(id: string): Promise<WebStatus | null> {
  const base = getApiUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(`${base}/encounters/${id}/web-status`, {
      headers: { ...COMMON_HEADERS, ...getAuthHeaders() },
      signal: controller.signal,
    });

    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`API ${res.status}: /encounters/${id}/web-status`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// WebSocket URL
// ---------------------------------------------------------------------------

export function getWsUrl(): string {
  return getApiUrl().replace(/^http/, "ws");
}
