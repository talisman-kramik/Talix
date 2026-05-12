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
import { fetchProviders, type ProviderSummary } from "../lib/api";

// How long a successful load stays "fresh" before a re-render-triggered
// loadProviders() call decides to refetch. Network errors don't update
// loadedAt, so a failed load will retry on the next invocation.
const PROVIDERS_FRESHNESS_MS = 15 * 60 * 1000; // 15 minutes

interface ProvidersState {
  providers: ProviderSummary[];
  /** Timestamp of the most recent successful load (null = never loaded). */
  loadedAt: number | null;
  loading: boolean;
  error: string | null;
  /**
   * Ensure providers are loaded. No-op if a fresh result is already in memory.
   * Pass `force: true` to bypass the freshness check (e.g. pull-to-refresh).
   */
  loadProviders: (opts?: { force?: boolean }) => Promise<void>;
}

export const useProviders = create<ProvidersState>((set, get) => ({
  providers: [],
  loadedAt: null,
  loading: false,
  error: null,
  loadProviders: async (opts) => {
    const { loading, loadedAt, providers } = get();

    // Already a load in flight — don't kick off a duplicate.
    if (loading) return;

    // Within freshness window and we have data → skip network call.
    const now = Date.now();
    const isFresh = loadedAt !== null && now - loadedAt < PROVIDERS_FRESHNESS_MS;
    if (!opts?.force && isFresh && providers.length > 0) return;

    set({ loading: true, error: null });
    try {
      const list = await fetchProviders();
      set({
        providers: list,
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
