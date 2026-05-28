/**
 * SOAP-notes (samples) cache — persistent AsyncStorage snapshot of the
 * `/encounters` list so the SOAP Notes tab can paint instantly on cold
 * start and the App-level login warmup can prefetch it in the background.
 *
 * Mirrors the shape used by EncountersScreen so both call-sites share one
 * canonical key (no risk of one writing v1 while the other reads v2).
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { SampleSummary } from "../lib/api";

export const SAMPLES_CACHE_KEY = "soapNotes.samples.cache.v2";

export type SamplesCacheEntry = {
  savedAt: number;
  items: SampleSummary[];
};

/** Read the persisted samples list. Returns null on miss / corrupt cache. */
export async function getCachedSamples(): Promise<SamplesCacheEntry | null> {
  try {
    const raw = await AsyncStorage.getItem(SAMPLES_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SamplesCacheEntry;
    if (!Array.isArray(parsed.items)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Persist a freshly-loaded samples list. Fire-and-forget. */
export function setCachedSamples(items: SampleSummary[]): void {
  AsyncStorage.setItem(
    SAMPLES_CACHE_KEY,
    JSON.stringify({ savedAt: Date.now(), items } satisfies SamplesCacheEntry),
  ).catch(() => {});
}
