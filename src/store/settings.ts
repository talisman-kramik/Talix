/**
 * Settings store — persists API URL and API key via AsyncStorage.
 *
 * The app talks to the **provider-facing** API (port 8000) or, for lab / GPU-only
 * setups, the **processing-pipeline** API (port 8100) — same REST surface for
 * encounters, providers, patients when both are configured.
 *
 * Optional defaults via .env (loaded at `expo start`):
 *   EXPO_PUBLIC_AI_SCRIBE_API_URL  — backend base URL
 *   EXPO_PUBLIC_AI_SCRIBE_API_KEY  — Bearer token for the new API key auth middleware
 */
import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";

import type { EclipseLocation } from "../lib/api";

const STORAGE_KEY = "ai_scribe_settings";
const PROVIDER_SERVER_PORT = "8000";
const DEFAULT_ECLIPSE_LOCATION: EclipseLocation = "pennsylvania";

function parseEclipseLocation(value: unknown): EclipseLocation | null {
  return value === "pennsylvania" || value === "baltimore" ? value : null;
}

/**
 * Derive a sensible default API URL.
 *
 * 1) `extra.apiUrl` from app.config.js (from EXPO_PUBLIC_AI_SCRIBE_API_URL)
 * 2) During Expo dev: LAN host from Metro + port 8000
 * 3) Fallback: localhost:8000
 */
function getDefaultApiUrl(): string {
  const fromConfig = Constants.expoConfig?.extra?.apiUrl;
  if (typeof fromConfig === "string" && fromConfig.trim().length > 0) {
    return fromConfig.trim().replace(/\/$/, "");
  }
  const hostUri = Constants.expoConfig?.hostUri; // e.g. "192.168.1.42:8081"
  if (hostUri) {
    const host = hostUri.split(":")[0]; // strip Expo port
    return `http://${host}:${PROVIDER_SERVER_PORT}`;
  }
  return `http://localhost:${PROVIDER_SERVER_PORT}`;
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
  loaded: boolean;
  /** Whether the user has explicitly saved a URL (vs. using auto-detected default) */
  configured: boolean;
  setApiUrl: (url: string) => void;
  setApiKey: (key: string) => void;
  setEclipseLocation: (location: EclipseLocation) => void;
  load: () => Promise<void>;
}

/** Default API key from build-time env var (set in .env as EXPO_PUBLIC_AI_SCRIBE_API_KEY) */
const DEFAULT_API_KEY = (process.env.EXPO_PUBLIC_AI_SCRIBE_API_KEY ?? "").trim();

function persist(state: Pick<SettingsState, "apiUrl" | "apiKey" | "eclipseLocation">) {
  AsyncStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      apiUrl: state.apiUrl,
      apiKey: state.apiKey,
      eclipseLocation: state.eclipseLocation,
    }),
  );
}

export const useSettings = create<SettingsState>((set, get) => ({
  apiUrl: DEFAULT_API_URL,
  apiKey: DEFAULT_API_KEY,
  eclipseLocation: DEFAULT_ECLIPSE_LOCATION,
  loaded: false,
  configured: false,
  setApiUrl: (url: string) => {
    set({ apiUrl: url, configured: true });
    const { apiKey, eclipseLocation } = get();
    persist({ apiUrl: url, apiKey, eclipseLocation });
  },
  setApiKey: (key: string) => {
    set({ apiKey: key });
    const { apiUrl, eclipseLocation } = get();
    persist({ apiUrl, apiKey: key, eclipseLocation });
  },
  setEclipseLocation: (location: EclipseLocation) => {
    set({ eclipseLocation: location });
    const { apiUrl, apiKey } = get();
    persist({ apiUrl, apiKey, eclipseLocation: location });
  },
  load: async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.apiUrl) set({ apiUrl: parsed.apiUrl, configured: true });
        // Prefer persisted key; fall back to build-time env default
        if (parsed.apiKey) set({ apiKey: parsed.apiKey });
        const location = parseEclipseLocation(parsed.eclipseLocation);
        if (location) set({ eclipseLocation: location });
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
