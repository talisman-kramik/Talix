/**
 * Settings store — persists API URL and API key via AsyncStorage.
 *
 * Mobile uses **AI Scribe on port 8100** (encounters, upload). Provider/patient
 * lists and demographics (DOB, provider id, injury date) come from the public
 * Eclipse API only — not internal web SQL routes.
 *
 * Optional defaults via .env (loaded at `expo start`):
 *   EXPO_PUBLIC_AI_SCRIBE_API_URL  — backend base URL (typically :8100)
 *   EXPO_PUBLIC_AI_SCRIBE_API_KEY  — Bearer token for the new API key auth middleware
 */
import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";

import type { EclipseLocation } from "../lib/api";

const STORAGE_KEY = "ai_scribe_settings";
const AI_SCRIBE_SERVER_PORT = "8100";
const DEFAULT_ECLIPSE_LOCATION: EclipseLocation = "pennsylvania";

function parseEclipseLocation(value: unknown): EclipseLocation | null {
  return value === "pennsylvania" || value === "baltimore" ? value : null;
}

/**
 * Derive a sensible default API URL.
 *
 * 1) `extra.apiUrl` from app.config.js (from EXPO_PUBLIC_AI_SCRIBE_API_URL)
 * 2) During Expo dev: LAN host from Metro + port 8100
 * 3) Fallback: localhost:8100
 */
function getDefaultApiUrl(): string {
  const fromConfig = Constants.expoConfig?.extra?.apiUrl;
  if (typeof fromConfig === "string" && fromConfig.trim().length > 0) {
    return fromConfig.trim().replace(/\/$/, "");
  }
  const hostUri = Constants.expoConfig?.hostUri; // e.g. "192.168.1.42:8081"
  if (hostUri) {
    const host = hostUri.split(":")[0]; // strip Expo port
    return `http://${host}:${AI_SCRIBE_SERVER_PORT}`;
  }
  return `http://localhost:${AI_SCRIBE_SERVER_PORT}`;
}

export const DEFAULT_API_URL = getDefaultApiUrl();

interface SettingsState {
  apiUrl: string;
  /** Bearer token for AI_SCRIBE_API_KEY middleware. Empty string = auth disabled (dev). */
  apiKey: string;
  /**
   * Selected Eclipse location. Drives the `source_system` filter for both
   * provider and patient lookups (pennsylvania → "Eclipse", baltimore → "Micro").
   */
  eclipseLocation: EclipseLocation;
  /**
   * Feature flag for the unified data source. When `true`, providers and
   * appointments are read from the AWS Pipeline_Server canonical endpoints
   * (`/providers`, `/appointments`) and encounter uploads reuse the
   * server-provided `encounter_id`. When `false` (default), behavior is
   * unchanged (existing Eclipse path).
   */
  unifiedSyncEnabled: boolean;
  loaded: boolean;
  /** Whether the user has explicitly saved a URL (vs. using auto-detected default) */
  configured: boolean;
  setApiUrl: (url: string) => void;
  setApiKey: (key: string) => void;
  setEclipseLocation: (location: EclipseLocation) => void;
  setUnifiedSyncEnabled: (enabled: boolean) => void;
  load: () => Promise<void>;
}

/** Default API key from build-time env var (set in .env as EXPO_PUBLIC_AI_SCRIBE_API_KEY) */
const DEFAULT_API_KEY = (process.env.EXPO_PUBLIC_AI_SCRIBE_API_KEY ?? "").trim();

/**
 * Persist only the Eclipse location.
 *
 * The API URL and key are intentionally **not** persisted. They come straight
 * from the build-time env (EXPO_PUBLIC_AI_SCRIBE_API_URL / _API_KEY via
 * eas.json / .env), so the value you ship in a build is always the value the
 * app uses. Persisting the URL previously caused stale dev URLs to "stick"
 * across rebuilds (a saved dev URL would override a freshly-built prod env).
 */
function persist(state: Pick<SettingsState, "eclipseLocation" | "unifiedSyncEnabled">) {
  AsyncStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      eclipseLocation: state.eclipseLocation,
      unifiedSyncEnabled: state.unifiedSyncEnabled,
    }),
  );
}

export const useSettings = create<SettingsState>((set, get) => ({
  apiUrl: DEFAULT_API_URL,
  apiKey: DEFAULT_API_KEY,
  eclipseLocation: DEFAULT_ECLIPSE_LOCATION,
  unifiedSyncEnabled: false,
  loaded: false,
  configured: false,
  // In-memory only override for the current session (not persisted, so the
  // build-time env always wins on the next launch).
  setApiUrl: (url: string) => {
    set({ apiUrl: url, configured: true });
  },
  setApiKey: (key: string) => {
    set({ apiKey: key });
  },
  setEclipseLocation: (location: EclipseLocation) => {
    set({ eclipseLocation: location });
    persist({ eclipseLocation: location, unifiedSyncEnabled: get().unifiedSyncEnabled });
  },
  setUnifiedSyncEnabled: (enabled: boolean) => {
    set({ unifiedSyncEnabled: enabled });
    persist({ eclipseLocation: get().eclipseLocation, unifiedSyncEnabled: enabled });
  },
  load: async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        // Only the Eclipse location and unified-sync flag are restored.
        // apiUrl/apiKey are always taken from the build-time env defaults set
        // above — any legacy persisted apiUrl/apiKey is ignored on purpose.
        const location = parseEclipseLocation(parsed.eclipseLocation);
        if (location) set({ eclipseLocation: location });
        if (typeof parsed.unifiedSyncEnabled === "boolean") {
          set({ unifiedSyncEnabled: parsed.unifiedSyncEnabled });
        }
      }
    } catch {
      // ignore
    }
    set({ loaded: true });
  },
}));

/** Synchronous getter for API URL (used by api.ts outside of React) */
export function getApiUrl(): string {
  return useSettings.getState().apiUrl;
}

/** Synchronous getter for API key Bearer token (used by api.ts outside of React) */
export function getApiKey(): string {
  return useSettings.getState().apiKey;
}

/** Synchronous getter for the selected Eclipse location. */
export function getEclipseLocation(): EclipseLocation {
  return useSettings.getState().eclipseLocation;
}

/**
 * Synchronous getter for the unified data source feature flag (used by api.ts
 * outside of React). When `true`, the canonical Pipeline_Server endpoints are
 * used instead of the Eclipse path.
 */
export function isUnifiedSyncEnabled(): boolean {
  return useSettings.getState().unifiedSyncEnabled;
}

