/**
 * Smart Edit (amend) API client.
 *
 * Talks directly to the AI Scribe middleware (port 8100). Matches the contract
 * defined by `MainAIScribe/MainAIScribe-livefix/api/routes/encounters.py`:
 *
 *   POST /encounters/{id}/amend         — JSON body, text instruction
 *   POST /encounters/{id}/amend/voice   — multipart `audio`, optional query
 *                                         params `version` / `provider_id`,
 *                                         optional form field `base_note`
 *
 * Both return the same `AmendResponse` shape; the server already persists the
 * amended note as a new version, so on Accept the mobile app only needs to
 * swap the displayed content and remember the returned `new_version` for the
 * next amend in the same session.
 */
import { getApiUrl, getApiKey } from "../store/settings";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AmendDiffChunkType = "equal" | "insert" | "delete";

export interface AmendDiffChunk {
  type: AmendDiffChunkType;
  text: string;
}

export interface AmendResponse {
  encounter_id: string;
  amendment_id: string;
  amended_note: string;
  diff: AmendDiffChunk[];
  base_version: string;
  new_version: string;
  llm_used: string;
  message: string;
}

export interface AmendSubmitOptions {
  /** Note version to amend — omit for latest. After an Accept this should be
   *  the previous response's `new_version` so versions chain correctly. */
  version?: string | null;
  /** Optional provider id; some LLM routing keys off this. */
  providerId?: string | null;
  /** Current rendered note markdown. Server uses this as a fallback when the
   *  pipeline-side file is missing (older encounters). Always send it when we
   *  have it. */
  baseNote?: string | null;
  /** AbortController signal so the UI can cancel an in-flight request. */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const COMMON_HEADERS: Record<string, string> = {
  "Bypass-Tunnel-Reminder": "true",
};

function authHeaders(): Record<string, string> {
  const key = getApiKey();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

/** Race a promise against a manual timeout. Falls back to AbortController if
 *  the caller passed a signal; otherwise installs its own so the fetch can be
 *  cancelled. */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

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

async function readErrorDetail(res: Response): Promise<string> {
  try {
    const body = await res.json();
    return body?.detail || body?.error || body?.message || `API ${res.status}`;
  } catch {
    return `API ${res.status}`;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Text amendment — 120 s timeout matches the web/middleware contract. */
export async function submitTextAmend(
  encounterId: string,
  instruction: string,
  options: AmendSubmitOptions = {},
): Promise<AmendResponse> {
  const trimmed = instruction.trim();
  if (!trimmed) {
    throw new Error("Instruction is empty.");
  }

  const body: Record<string, unknown> = { instruction: trimmed };
  if (options.version) body.version = options.version;
  if (options.providerId) body.provider_id = options.providerId;
  if (options.baseNote) body.base_note = options.baseNote;

  const url = `${getApiUrl()}/encounters/${encodeURIComponent(encounterId)}/amend`;
  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        ...COMMON_HEADERS,
        ...authHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    120_000,
    options.signal,
  );

  if (!res.ok) {
    throw new Error(await readErrorDetail(res));
  }
  return res.json();
}

/** Voice amendment — 180 s timeout (extra 60 s for server-side transcription). */
export async function submitVoiceAmend(
  encounterId: string,
  audio: { uri: string; name?: string; mimeType?: string },
  options: AmendSubmitOptions = {},
): Promise<AmendResponse> {
  const params = new URLSearchParams();
  if (options.version) params.append("version", options.version);
  if (options.providerId) params.append("provider_id", options.providerId);

  const url =
    `${getApiUrl()}/encounters/${encodeURIComponent(encounterId)}/amend/voice` +
    (params.toString() ? `?${params.toString()}` : "");

  const form = new FormData();
  form.append("audio", {
    uri: audio.uri,
    name: audio.name || "instruction.m4a",
    type: audio.mimeType || "audio/m4a",
  } as unknown as Blob);
  if (options.baseNote) form.append("base_note", options.baseNote);

  // Don't set Content-Type — fetch auto-injects the multipart boundary.
  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { ...COMMON_HEADERS, ...authHeaders() },
      body: form,
    },
    180_000,
    options.signal,
  );

  if (!res.ok) {
    throw new Error(await readErrorDetail(res));
  }
  return res.json();
}
