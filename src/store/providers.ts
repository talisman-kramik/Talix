/**
 * Providers store — single source of truth for the Eclipse provider list.
 *
 * Why a Zustand store instead of each screen calling `fetchProviders()`?
 *  - Eclipse provider lookups are slow (~6-9s cold), so we only want to fetch
 *    once per app session and share the result with every screen.
 *  - Pre-warmed at login (see App.tsx) so Record / SOAP Notes / etc. show the
 *    provider dropdown instantly the first time they mount.
 *  - `fetchProviders()` itself still does an in-memory cache + AsyncStorage
 *    fallback inside `src/lib/api.ts`; this store just lifts the React state
 *    around it so subscribers re-render when the list updates.
 *
 * Location-switch safety:
 *  - A generation counter + AbortController ensures that if the user toggles
 *    Pennsylvania → Baltimore mid-flight, the Pennsylvania response can never
 *    overwrite the Baltimore list. The in-flight network request is aborted
 *    immediately, and a small debounce avoids spamming the backend on rapid
 *    toggles.
 */
import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { fetchProviders, type EclipseLocation, type ProviderSummary } from "../lib/api";

// How long a successful load stays "fresh" before a re-render-triggered
// loadProviders() call decides to refetch. Bumped from 15 min → 24 h
// because (a) Eclipse providers barely change day-to-day, and (b) the
// previous window forced a 6-16 s foreground network call any time the
// user reopened the app after lunch. The Record screen never blocks on
// this refresh anyway — it always renders the cached list — but a longer
// freshness window also means we don't pound Eclipse from every device.
const PROVIDERS_FRESHNESS_MS = 24 * 60 * 60 * 1000;

// Tiny debounce between a location selection and the actual network call.
// Lets a rapid PA → Baltimore → PA toggle collapse to a single final fetch
// instead of hammering Eclipse three times.
const SWITCH_DEBOUNCE_MS = 300;

// AsyncStorage key per location for the persisted providers snapshot. We
// keep BOTH PA and Baltimore on disk simultaneously so a location toggle
// can paint the new dropdown instantly from the other location's cache,
// instead of wiping the list and showing a spinner while the network
// call runs. Bump the version suffix if the persisted shape ever changes.
const PROVIDERS_CACHE_KEY_PREFIX = "providers.cache.v2:";
function providersCacheKey(location: EclipseLocation): string {
  return `${PROVIDERS_CACHE_KEY_PREFIX}${location}`;
}
type PersistedProvidersCache = {
  savedAt: number;
  location: EclipseLocation;
  providers: ProviderSummary[];
};

// Module-scoped coordination state. Kept outside the Zustand store so we can
// freely mutate without triggering renders — they're implementation details
// of the cancellation logic, not part of the public state.
let activeGeneration = 0;
let activeRequestedLocation: EclipseLocation | null = null;
let activeAbortController: AbortController | null = null;
let activeDebounceTimer: ReturnType<typeof setTimeout> | null = null;

interface ProvidersState {
  /** Providers currently displayed (for the most recently loaded location). */
  providers: ProviderSummary[];
  /** Location the displayed providers belong to. */
  loadedLocation: EclipseLocation | null;
  /** Timestamp of the most recent successful load (null = never loaded). */
  loadedAt: number | null;
  loading: boolean;
  error: string | null;
  /** True once *any* AsyncStorage cache has been read (regardless of result). */
  hydrated: boolean;
  /**
   * Read the persisted providers cache for `location` and seed state with
   * it so the UI paints a populated dropdown instantly. Called both on
   * app boot (with the current location) and on every location toggle so
   * the new location's dropdown is never blank during the background
   * Eclipse refresh.
   */
  hydrateFromCache: (location: EclipseLocation) => Promise<void>;
  /**
   * Ensure providers are loaded for the given location. No-op if a fresh
   * result for the same location is already in memory. Pass `force: true`
   * to bypass the freshness check (e.g. pull-to-refresh).
   *
   * Switching locations aborts any in-flight request for the previous
   * location, debounces briefly, and then fetches the new one. A
   * generation counter guarantees only the most recently requested
   * location's result can ever be committed to state.
   */
  loadProviders: (
    location: EclipseLocation,
    opts?: { force?: boolean },
  ) => Promise<void>;
}

export const useProviders = create<ProvidersState>((set, get) => ({
  providers: [],
  loadedLocation: null,
  loadedAt: null,
  loading: false,
  error: null,
  hydrated: false,
  hydrateFromCache: async (location) => {
    // Read the requested-location snapshot from disk and paint it. Called
    // both on app boot (with the current `eclipseLocation`) and on every
    // location switch (so the new location's dropdown is never blank).
    try {
      const raw = await AsyncStorage.getItem(providersCacheKey(location));
      if (!raw) return;
      const parsed = JSON.parse(raw) as PersistedProvidersCache;
      if (!Array.isArray(parsed.providers) || parsed.providers.length === 0) {
        return;
      }
      // Only paint when nothing fresh has landed for this location yet — a
      // concurrent loadProviders() may have already populated the store
      // with newer data, in which case our disk snapshot is older. We
      // intentionally don't set `loadedAt` here so the next loadProviders
      // call still treats this as a background-refresh candidate (with the
      // 24 h freshness window it usually won't bother).
      const { loadedAt, loadedLocation } = get();
      const alreadyHasFresherDataForLocation =
        loadedLocation === location && loadedAt !== null;
      if (alreadyHasFresherDataForLocation) return;
      set({
        providers: parsed.providers,
        loadedLocation: location,
      });
    } catch {
      // Corrupt or missing — silent.
    } finally {
      set({ hydrated: true });
    }
  },
  loadProviders: async (location, opts) => {
    // Same-location dedupe: if a request for this exact location is already
    // queued or in flight, multiple subscribers (App pre-warm + screen mount)
    // should share it rather than restart it.
    const sameLocationInFlight =
      activeRequestedLocation === location &&
      (activeDebounceTimer !== null || activeAbortController !== null);
    if (!opts?.force && sameLocationInFlight) return;

    // Freshness short-circuit: skip everything when we already have a fresh
    // result for this location in store state.
    const { loadedAt, providers, loadedLocation } = get();
    const now = Date.now();
    const isFresh = loadedAt !== null && now - loadedAt < PROVIDERS_FRESHNESS_MS;
    if (
      !opts?.force &&
      isFresh &&
      providers.length > 0 &&
      loadedLocation === location
    ) {
      return;
    }

    // From here on we're starting a new request. Cancel any pending or
    // in-flight work for the *previous* location so a late-arriving response
    // can't overwrite this selection.
    if (activeDebounceTimer) {
      clearTimeout(activeDebounceTimer);
      activeDebounceTimer = null;
    }
    if (activeAbortController) {
      activeAbortController.abort();
      activeAbortController = null;
    }
    const myGeneration = ++activeGeneration;
    activeRequestedLocation = location;

    // Switching to a different location → try to hydrate that location's
    // persisted snapshot first so the dropdown paints something other than
    // a blank list during the background Eclipse refresh. Only fall back to
    // the "clear and show loading" path if we have nothing on disk for the
    // target location yet (true first-ever use of that location).
    if (loadedLocation !== location) {
      try {
        const raw = await AsyncStorage.getItem(providersCacheKey(location));
        if (raw) {
          const parsed = JSON.parse(raw) as PersistedProvidersCache;
          if (Array.isArray(parsed.providers) && parsed.providers.length > 0) {
            set({
              providers: parsed.providers,
              loadedLocation: location,
              loadedAt: null, // disk snapshot → still treat as candidate for refresh
            });
          } else {
            set({ providers: [], loadedLocation: null, loadedAt: null });
          }
        } else {
          set({ providers: [], loadedLocation: null, loadedAt: null });
        }
      } catch {
        set({ providers: [], loadedLocation: null, loadedAt: null });
      }
    }
    // Only flag `loading: true` when we genuinely have nothing on screen —
    // a refresh of already-painted providers shouldn't blank out the
    // dropdown or trigger the skeleton loader.
    const haveSomethingToShow = get().providers.length > 0;
    set({ loading: !haveSomethingToShow, error: null });

    // Small debounce so rapid toggles collapse to one network call.
    await new Promise<void>((resolve) => {
      activeDebounceTimer = setTimeout(() => {
        activeDebounceTimer = null;
        resolve();
      }, SWITCH_DEBOUNCE_MS);
    });
    if (myGeneration !== activeGeneration) {
      // The user picked a different location during the debounce window.
      return;
    }

    const controller = new AbortController();
    activeAbortController = controller;
    try {
      const list = await fetchProviders(location, { signal: controller.signal });
      if (myGeneration !== activeGeneration) {
        // The user picked a different location while the request was in flight.
        return;
      }
      set({
        providers: list,
        loadedLocation: location,
        loadedAt: Date.now(),
        loading: false,
        error: null,
      });
      // Persist a per-location snapshot so the next cold start (or
      // location toggle) for this same location can hydrate instantly.
      // Fire-and-forget — never block the UI on disk I/O.
      AsyncStorage.setItem(
        providersCacheKey(location),
        JSON.stringify({
          savedAt: Date.now(),
          location,
          providers: list,
        } satisfies PersistedProvidersCache),
      ).catch(() => {});
    } catch (err) {
      if (myGeneration !== activeGeneration) return;
      const isAbort =
        (err as { name?: string } | null)?.name === "AbortError" ||
        /aborted/i.test(String((err as Error | null)?.message ?? ""));
      if (isAbort) return; // intentional cancel — leave loading state to the new call
      set({
        loading: false,
        error: err instanceof Error ? err.message : "Failed to load providers",
      });
    } finally {
      if (activeAbortController === controller) {
        activeAbortController = null;
      }
      if (
        activeRequestedLocation === location &&
        myGeneration === activeGeneration
      ) {
        activeRequestedLocation = null;
      }
    }
  },
}));
