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
 */
import { create } from "zustand";
import { fetchProviders, type EclipseLocation, type ProviderSummary } from "../lib/api";

// How long a successful load stays "fresh" before a re-render-triggered
// loadProviders() call decides to refetch. Network errors don't update
// loadedAt, so a failed load will retry on the next invocation.
const PROVIDERS_FRESHNESS_MS = 15 * 60 * 1000; // 15 minutes

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
   * Switching locations always triggers a (potentially cached) fetch so the
   * UI reflects the new selection.
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
    const { loading, loadedAt, providers, loadedLocation } = get();

    // Already a load in flight for any location — don't kick off a duplicate.
    if (loading) return;

    // Within freshness window and we have data for the *same* location → skip.
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

    // If switching locations, clear stale results so screens render the
    // correct list (or a loading state) instead of the previous location's
    // providers.
    if (loadedLocation !== location) {
      set({ providers: [], loadedLocation: null, loadedAt: null });
    }

    set({ loading: true, error: null });
    try {
      const list = await fetchProviders(location);
      set({
        providers: list,
        loadedLocation: location,
        loadedAt: Date.now(),
        loading: false,
        error: null,
      });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : "Failed to load providers",
      });
    }
  },
}));
