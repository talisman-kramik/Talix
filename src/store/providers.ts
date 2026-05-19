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
import { fetchProviders, type EclipseLocation, type ProviderSummary } from "../lib/api";

// How long a successful load stays "fresh" before a re-render-triggered
// loadProviders() call decides to refetch. Network errors don't update
// loadedAt, so a failed load will retry on the next invocation.
const PROVIDERS_FRESHNESS_MS = 15 * 60 * 1000; // 15 minutes

// Tiny debounce between a location selection and the actual network call.
// Lets a rapid PA → Baltimore → PA toggle collapse to a single final fetch
// instead of hammering Eclipse three times.
const SWITCH_DEBOUNCE_MS = 300;

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

    // Switching to a different location → clear the stale list so the UI
    // renders a loading state instead of leaving the previous location's
    // providers visible. Keep them as-is when refreshing the same location.
    if (loadedLocation !== location) {
      set({ providers: [], loadedLocation: null, loadedAt: null });
    }
    set({ loading: true, error: null });

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
