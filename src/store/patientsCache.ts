/**
 * Patients cache — keeps the Eclipse patient list for each
 * (providerId, appointmentDate, location) combination warm in memory and on
 * disk so the Record screen paints a populated patient picker instantly
 * instead of waiting on the 3–5 s Eclipse round-trip.
 *
 * Layout:
 *  - In-memory `Map` for the lifetime of the JS runtime. Hits here are free
 *    (synchronous).
 *  - AsyncStorage snapshot per key for cold-start hydration. Loaded lazily
 *    via `getCachedPatients` when the in-memory map misses.
 *
 * Freshness:
 *  - `FRESH_TTL_MS` (30 min): caller can use the cached list without
 *    bothering to refetch. Bumped from 5 min so resuming the app after a
 *    short break doesn't fire an Eclipse round-trip just to confirm the
 *    list hasn't changed.
 *  - `STALE_TTL_MS` (7 days): caller should paint cached data *and*
 *    trigger a background refresh. Long window because the most useful
 *    "instant" state — patients for *today's* clinic — is the same all day,
 *    and a stale paint with background refresh feels infinitely better than
 *    a spinner.
 *  - Older than that: caller should ignore the cache and treat the result
 *    as a normal cold load.
 *
 * Why not just a Zustand store? The Record screen already has subtle
 * provider-change / cancel logic around the patient fetch. A plain
 * key/value cache that returns "here's the previously-good list for this
 * key" composes more cleanly with the existing useEffect than a global
 * store that would require re-wiring subscriptions per provider+date.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { EclipseLocation, PatientSearchResult } from "../lib/api";

const KEY_PREFIX = "patients.cache.v1:";

export const FRESH_TTL_MS = 30 * 60 * 1000;
export const STALE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type CacheEntry = {
  savedAt: number;
  patients: PatientSearchResult[];
};

const memCache = new Map<string, CacheEntry>();

export type CachedPatientsState =
  | { status: "miss" }
  | { status: "fresh"; patients: PatientSearchResult[]; savedAt: number }
  | { status: "stale"; patients: PatientSearchResult[]; savedAt: number };

function makeKey(
  providerId: string,
  appointmentDate: string,
  location: EclipseLocation,
): string {
  return `${KEY_PREFIX}${location}|${providerId}|${appointmentDate}`;
}

/**
 * Return the cached patient list for this (provider, date, location), or
 * `{ status: "miss" }` if nothing is cached or the cache is too stale to
 * even bother painting. Hits the in-memory map first, then AsyncStorage.
 *
 * Callers should:
 *  - `"fresh"` → paint immediately, skip the network fetch entirely.
 *  - `"stale"` → paint immediately, fire a background refresh, swap when
 *    new data arrives.
 *  - `"miss"`  → spinner / skeleton, normal fetch.
 */
export async function getCachedPatients(
  providerId: string,
  appointmentDate: string,
  location: EclipseLocation,
): Promise<CachedPatientsState> {
  const key = makeKey(providerId, appointmentDate, location);
  let entry = memCache.get(key);

  if (!entry) {
    try {
      const raw = await AsyncStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw) as CacheEntry;
        if (Array.isArray(parsed.patients)) {
          entry = parsed;
          memCache.set(key, parsed);
        }
      }
    } catch {
      // Corrupt or missing cache entry — fall through.
    }
  }

  if (!entry) return { status: "miss" };

  const age = Date.now() - entry.savedAt;
  if (age > STALE_TTL_MS) {
    // Too old to even paint — let the screen show its loading state and
    // wait for fresh data.
    return { status: "miss" };
  }
  if (age <= FRESH_TTL_MS) {
    return {
      status: "fresh",
      patients: entry.patients,
      savedAt: entry.savedAt,
    };
  }
  return { status: "stale", patients: entry.patients, savedAt: entry.savedAt };
}

/**
 * Synchronous variant for the common case where we just want to peek at the
 * in-memory map (e.g. seeding initial useState on screen mount). Skips the
 * AsyncStorage fallback, so a true cold start returns `null` even if a
 * disk snapshot exists.
 */
export function peekCachedPatients(
  providerId: string,
  appointmentDate: string,
  location: EclipseLocation,
): PatientSearchResult[] | null {
  const key = makeKey(providerId, appointmentDate, location);
  const entry = memCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.savedAt > STALE_TTL_MS) return null;
  return entry.patients;
}

/**
 * Persist a freshly-fetched patient list for this (provider, date, location).
 * Updates both the in-memory map and AsyncStorage. Disk writes are
 * fire-and-forget so the caller never blocks on I/O.
 */
export function setCachedPatients(
  providerId: string,
  appointmentDate: string,
  location: EclipseLocation,
  patients: PatientSearchResult[],
): void {
  const key = makeKey(providerId, appointmentDate, location);
  const entry: CacheEntry = { savedAt: Date.now(), patients };
  memCache.set(key, entry);
  AsyncStorage.setItem(key, JSON.stringify(entry)).catch(() => {});
}
