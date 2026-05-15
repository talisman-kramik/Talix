/**
 * SOAP Notes list — shows all samples with searchable provider picker and status badges.
 */
import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  useWindowDimensions,
  TextInput,
  Modal,
  ActivityIndicator,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useNavigation } from "@react-navigation/native";

import Badge from "../components/Badge";
import { colors, fontSize, spacing, radius } from "../lib/theme";
import { fetchSamples, type SampleSummary, type ProviderSummary } from "../lib/api";
import { useSettings } from "../store/settings";
import { useProviders } from "../store/providers";
import { formatDateUS } from "../lib/date";

function toTitleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function formatEncounterTitle(sampleId: string): string {
  const parts = sampleId.split("_").filter(Boolean);
  const nameParts = parts.filter((p) => !/^\d+$/.test(p) && !/^\d{4}-\d{2}-\d{2}$/.test(p));
  if (nameParts.length >= 2) return toTitleCase(nameParts.slice(0, 2).join(" "));
  if (nameParts.length === 1) return toTitleCase(nameParts[0]);
  return sampleId;
}

function getDateFromSampleId(sampleId: string): string {
  const match = sampleId.match(/\d{4}-\d{2}-\d{2}/);
  if (!match) return "N/A";
  return formatDateUS(match[0]);
}

// Extract a sortable ISO date (YYYY-MM-DD) from a sample id. Handles both
// dashed (`..._2026-05-12`) and compact (`..._20260512`) encounter id formats.
// Returns "" when no date is encoded, which we sort to the bottom.
function getSortableDateFromSampleId(sampleId: string): string {
  const dashed = sampleId.match(/(\d{4}-\d{2}-\d{2})/);
  if (dashed) return dashed[1];
  const compact = sampleId.match(/(19|20)\d{6}/);
  if (compact) {
    const v = compact[0];
    return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
  }
  return "";
}

export default function EncountersScreen() {
  const nav = useNavigation<any>();
  const { width } = useWindowDimensions();
  const isTablet = width >= 768;
  const numColumns = 1;
  const apiUrl = useSettings((s) => s.apiUrl);
  const eclipseLocation = useSettings((s) => s.eclipseLocation);

  const [samples, setSamples] = useState<SampleSummary[]>([]);
  const [filterProvider, setFilterProvider] = useState<string | null>(null);
  const [filterMode, setFilterMode] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [samplesError, setSamplesError] = useState<string | null>(null);
  const [showProviderPicker, setShowProviderPicker] = useState(false);
  const [providerSearch, setProviderSearch] = useState("");

  // Providers come from the shared store (pre-warmed at login). We just read
  // them — no fetch needed here, so SOAP Notes is no longer gated on the
  // slow Eclipse round-trip.
  const providers = useProviders((s) => s.providers);
  const loadProviders = useProviders((s) => s.loadProviders);

  // Tracks whether we've ever had a successful samples load — used to skip the
  // full-screen spinner on re-focus / pull-to-refresh so the existing list
  // stays visible.
  const hasLoadedSamplesOnce = useRef(false);

  const loadData = useCallback(async () => {
    if (!hasLoadedSamplesOnce.current) setIsLoading(true);

    // Kick off (or no-op) a providers refresh in the background for the
    // currently selected Eclipse location. We don't block the SOAP notes UI
    // on it — the dropdown will hydrate from the store whenever the load
    // resolves.
    void loadProviders(eclipseLocation).catch(() => {});

    try {
      const list = await fetchSamples();
      setSamples(list);
      setSamplesError(null);
      hasLoadedSamplesOnce.current = true;
    } catch (err) {
      // CRITICAL: do NOT wipe `samples` on error. Surface the error but keep
      // showing the last successful list so a network blip never silently
      // turns into an empty "0 SOAP notes" screen.
      console.warn("Failed to load encounters", err);
      setSamplesError(err instanceof Error ? err.message : "Failed to load SOAP notes");
    } finally {
      setIsLoading(false);
    }
  }, [loadProviders, eclipseLocation]);

  useEffect(() => {
    loadData();
  }, [loadData, apiUrl]);

  useFocusEffect(
    useCallback(() => {
      void loadData();
    }, [loadData]),
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await loadData().catch(() => {});
    setRefreshing(false);
  };

  const selectedProviderObj = providers.find(p => p.id === filterProvider);

  const sortedProviders = useMemo(() => {
    return [...providers].sort((a, b) => {
      const an = (a.name ?? a.id ?? "").toLowerCase();
      const bn = (b.name ?? b.id ?? "").toLowerCase();
      return an.localeCompare(bn);
    });
  }, [providers]);

  const filteredProviders = useMemo(() => {
    const q = providerSearch.trim().toLowerCase();
    if (!q) return sortedProviders;
    return sortedProviders.filter((p) => {
      const name = (p.name ?? "").toLowerCase();
      const id = (p.id ?? "").toLowerCase();
      return name.includes(q) || id.includes(q);
    });
  }, [sortedProviders, providerSearch]);

  const closeProviderPicker = () => {
    setShowProviderPicker(false);
    setProviderSearch("");
  };

  // Show newest SOAP notes first. Date is parsed from the sample id (no
  // created_at on SampleSummary). Tiebreak by sample id descending so the
  // ordering is stable across renders even when dates collide.
  const sortedSamples = useMemo(() => {
    return [...samples].sort((a, b) => {
      const da = getSortableDateFromSampleId(a.sample_id);
      const db = getSortableDateFromSampleId(b.sample_id);
      if (da !== db) {
        if (!da) return 1;
        if (!db) return -1;
        return db.localeCompare(da);
      }
      return b.sample_id.localeCompare(a.sample_id);
    });
  }, [samples]);

  // Normalize for free-text search so "Scott pello", "scott_pello",
  // "dr.scott-pello" all match the same provider. Lowercases and collapses
  // any run of non-alphanumerics into a single space.
  const normalizeForSearch = (value: unknown): string =>
    String(value ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();

  // Tokenize for provider matching: drop the "dr" honorific so a stored
  // physician like "dr_scott_pello" still matches the Eclipse provider
  // name "Scott Pello".
  const providerTokens = (value: unknown): string[] =>
    normalizeForSearch(value)
      .split(" ")
      .filter((tok) => tok && tok !== "dr");

  // True if every token in the provider name is present in the sample's
  // physician string. Handles "Scott Pello" vs "dr_scott_pello",
  // "Scott M Pello" vs "scott pello", etc.
  const physicianMatchesProvider = (
    physician: unknown,
    provider: ProviderSummary,
  ): boolean => {
    const physTokens = new Set(providerTokens(physician));
    if (physTokens.size === 0) return false;

    // Try the provider's display name first, then fall back to its id
    // (which contains the encoded "first|last").
    const nameTokens = providerTokens(provider.name ?? "");
    const candidateTokens = nameTokens.length > 0
      ? nameTokens
      : providerTokens(provider.id.replace(/^eclname:/, ""));

    if (candidateTokens.length === 0) return false;
    return candidateTokens.every((tok) => physTokens.has(tok));
  };

  const normalizedSearch = normalizeForSearch(search);

  const filtered = sortedSamples.filter((s) => {
    if (selectedProviderObj && !physicianMatchesProvider(s.physician, selectedProviderObj)) {
      return false;
    }
    if (filterMode && s.mode !== filterMode) return false;
    if (normalizedSearch) {
      // Match against every field visible on the card: patient name (derived
      // from the sample id), provider, mode, raw note id, and the formatted
      // date of service.
      const haystack = normalizeForSearch(
        [
          s.sample_id,
          formatEncounterTitle(s.sample_id),
          s.physician,
          s.mode,
          getDateFromSampleId(s.sample_id),
        ]
          .filter(Boolean)
          .join(" "),
      );
      if (!haystack.includes(normalizedSearch)) return false;
    }
    return true;
  });

  const scoreVariant = (score: number | null | undefined) => {
    if (score == null) return "neutral" as const;
    if (score >= 4.5) return "success" as const;
    if (score >= 4.0) return "info" as const;
    if (score >= 3.5) return "warning" as const;
    return "error" as const;
  };

  const ModeChip = ({ label, value }: { label: string; value: string | null }) => {
    const active = filterMode === value;
    return (
      <TouchableOpacity
        style={[styles.modeChip, active && styles.modeChipActive]}
        onPress={() => setFilterMode(active ? null : value)}
        activeOpacity={0.7}
      >
        <Text style={[styles.modeChipText, active && styles.modeChipTextActive]}>{label}</Text>
      </TouchableOpacity>
    );
  };

  const renderItem = ({ item }: { item: SampleSummary }) => {
    const score = item.quality?.overall;
    const encounterTitle = formatEncounterTitle(item.sample_id);
    const dos = getDateFromSampleId(item.sample_id);
    return (
      <TouchableOpacity
        style={[styles.card, isTablet && styles.tabletCard]}
        onPress={() => nav.navigate("EncounterDetail", { sampleId: item.sample_id })}
        activeOpacity={0.7}
      >
        <View style={styles.cardHeader}>
          <View style={styles.cardTitleRow}>
            <Ionicons name="document-text-outline" size={16} color={colors.brand} style={{ marginRight: spacing.xs }} />
            <Text style={styles.sampleId} numberOfLines={1}>{encounterTitle}</Text>
          </View>
          {score != null && (
            <Badge label={score.toFixed(2)} variant={scoreVariant(score)} />
          )}
        </View>

        <View style={styles.detailGrid}>
          <Text style={styles.detailLine}>
            <Text style={styles.detailLabel}>Date: </Text>
            {dos}
          </Text>
          <Text style={styles.detailLine} numberOfLines={1}>
            <Text style={styles.detailLabel}>Provider: </Text>
            {item.physician || "N/A"}
          </Text>
          <Text style={styles.detailLine}>
            <Text style={styles.detailLabel}>Mode: </Text>
            {item.mode === "ambient" ? "Conversation" : "Dictation"}
          </Text>
          <Text style={styles.detailLine} numberOfLines={1}>
            <Text style={styles.detailLabel}>Note ID: </Text>
            {item.sample_id}
          </Text>
        </View>

        <View style={styles.cardFooter}>
          <Badge label={item.mode} variant={item.mode === "dictation" ? "info" : "success"} />
          {item.latest_version && (
            <View style={styles.versionBadge}>
              <Text style={styles.versionText}>{item.latest_version}</Text>
            </View>
          )}
          {item.has_gold && (
            <Ionicons name="star" size={12} color="#F59E0B" />
          )}
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      {/* Search bar */}
      <View style={styles.topSection}>
        <View style={styles.searchBox}>
          <Ionicons name="search" size={16} color={colors.textTertiary} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search SOAP notes..."
            style={styles.searchInput}
            placeholderTextColor={colors.textTertiary}
          />
          {search.length > 0 && (
            <TouchableOpacity onPress={() => setSearch("")}>
              <Ionicons name="close-circle" size={16} color={colors.textTertiary} />
            </TouchableOpacity>
          )}
        </View>

        {/* Mode filter row */}
        <View style={styles.modeRow}>
          <TouchableOpacity
            style={[styles.modeChip, filterMode === null && styles.modeChipActive]}
            onPress={() => setFilterMode(null)}
            activeOpacity={0.7}
          >
            <Text style={[styles.modeChipText, filterMode === null && styles.modeChipTextActive]}>All</Text>
          </TouchableOpacity>
          <ModeChip label="Dictation" value="dictation" />
          <ModeChip label="Conversation" value="ambient" />
        </View>
      </View>

      {/* Provider filter — single dropdown opens searchable modal */}
      {providers.length > 0 && (
        <View style={styles.providerSection}>
          <TouchableOpacity
            style={styles.providerDropdown}
            onPress={() => setShowProviderPicker(true)}
            activeOpacity={0.7}
          >
            <Ionicons name="people" size={16} color={colors.textSecondary} />
            <Text style={styles.providerDropdownLabel}>Provider:</Text>
            <Text style={styles.providerDropdownValue} numberOfLines={1}>
              {selectedProviderObj?.name ?? selectedProviderObj?.id ?? "All Providers"}
            </Text>
            {filterProvider !== null && (
              <TouchableOpacity
                onPress={(e) => {
                  e.stopPropagation();
                  setFilterProvider(null);
                }}
                hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
              >
                <Ionicons name="close-circle" size={16} color={colors.textTertiary} />
              </TouchableOpacity>
            )}
            <Ionicons name="chevron-down" size={16} color={colors.textTertiary} />
          </TouchableOpacity>
        </View>
      )}

      {/* Results count */}
      <View style={styles.resultsRow}>
        <Text style={styles.resultsText}>
          {filtered.length} SOAP note{filtered.length !== 1 ? "s" : ""}
        </Text>
      </View>

      {/* Provider picker modal */}
      <Modal
        visible={showProviderPicker}
        animationType="fade"
        transparent
        onRequestClose={closeProviderPicker}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Select Provider</Text>
              <TouchableOpacity onPress={closeProviderPicker} hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}>
                <Ionicons name="close" size={20} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>
            <View style={styles.modalSearchBox}>
              <Ionicons name="search" size={16} color={colors.textTertiary} />
              <TextInput
                value={providerSearch}
                onChangeText={setProviderSearch}
                placeholder="Search providers..."
                style={styles.modalSearchInput}
                placeholderTextColor={colors.textTertiary}
                autoFocus
              />
              {providerSearch.length > 0 && (
                <TouchableOpacity onPress={() => setProviderSearch("")}>
                  <Ionicons name="close-circle" size={16} color={colors.textTertiary} />
                </TouchableOpacity>
              )}
            </View>
            <FlatList
              data={[{ id: "__all__" } as ProviderSummary, ...filteredProviders]}
              keyExtractor={(p) => p.id}
              keyboardShouldPersistTaps="handled"
              style={styles.modalList}
              renderItem={({ item }) => {
                const isAll = item.id === "__all__";
                const isActive = isAll ? filterProvider === null : filterProvider === item.id;
                const label = isAll ? "All Providers" : (item.name ?? item.id);
                return (
                  <TouchableOpacity
                    style={[styles.modalRow, isActive && styles.modalRowActive]}
                    onPress={() => {
                      setFilterProvider(isAll ? null : item.id);
                      closeProviderPicker();
                    }}
                    activeOpacity={0.7}
                  >
                    <Ionicons
                      name={isAll ? "people" : "person"}
                      size={16}
                      color={isActive ? colors.brand : colors.textSecondary}
                    />
                    <Text style={[styles.modalRowText, isActive && styles.modalRowTextActive]} numberOfLines={1}>
                      {label}
                    </Text>
                    {isActive && <Ionicons name="checkmark" size={16} color={colors.brand} />}
                  </TouchableOpacity>
                );
              }}
              ListEmptyComponent={
                <Text style={styles.modalEmpty}>No providers match "{providerSearch}".</Text>
              }
            />
          </View>
        </View>
      </Modal>

      {samplesError && samples.length > 0 ? (
        <View style={styles.errorBanner}>
          <Ionicons name="cloud-offline-outline" size={16} color={colors.warning} />
          <Text style={styles.errorBannerText} numberOfLines={2}>
            Couldn't refresh — showing last loaded list.
          </Text>
          <TouchableOpacity onPress={() => void loadData()} hitSlop={8}>
            <Text style={styles.errorBannerRetry}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <FlatList
        data={filtered}
        keyExtractor={(s) => s.sample_id}
        renderItem={renderItem}
        numColumns={numColumns}
        key={numColumns}
        contentContainerStyle={[styles.listContent, isTablet && styles.tabletListContent]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.brand} />}
        ListEmptyComponent={
          isLoading ? (
            <View style={styles.empty}>
              <ActivityIndicator size="large" color={colors.brand} />
              <Text style={styles.emptyTitle}>Loading SOAP notes...</Text>
            </View>
          ) : (
            <View style={styles.empty}>
              <Ionicons name="document-text-outline" size={48} color={colors.textTertiary} />
              <Text style={styles.emptyTitle}>No SOAP notes found</Text>
              <Text style={styles.emptySubtitle}>Try clearing your filters or pull to refresh</Text>
            </View>
          )
        }
      />
    </View>
  );
}

const CHIP_HEIGHT = 32;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },

  // Top section
  topSection: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    gap: spacing.sm,
  },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#FEF3C7",
    borderColor: colors.warning,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    gap: spacing.sm,
  },
  errorBannerText: {
    flex: 1,
    fontSize: fontSize.sm,
    color: colors.text,
  },
  errorBannerRetry: {
    fontSize: fontSize.sm,
    fontWeight: "600",
    color: colors.brand,
  },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    height: 44,
  },
  searchInput: {
    flex: 1,
    marginLeft: spacing.sm,
    fontSize: fontSize.sm,
    color: colors.text,
  },

  // Mode chips row
  modeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  modeChip: {
    height: CHIP_HEIGHT,
    paddingHorizontal: spacing.md,
    borderRadius: CHIP_HEIGHT / 2,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    alignItems: "center",
    justifyContent: "center",
  },
  modeChipActive: {
    backgroundColor: colors.brand,
    borderColor: colors.brand,
  },
  modeChipText: {
    fontSize: fontSize.xs,
    fontWeight: "600",
    color: colors.textSecondary,
  },
  modeChipTextActive: {
    color: "#FFFFFF",
  },

  // Provider dropdown
  providerSection: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  providerDropdown: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    height: 44,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  providerDropdownLabel: {
    fontSize: fontSize.xs,
    color: colors.textSecondary,
    fontWeight: "600",
  },
  providerDropdownValue: {
    flex: 1,
    fontSize: fontSize.sm,
    color: colors.text,
    fontWeight: "600",
  },

  // Provider picker modal
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent: "center",
    padding: spacing.lg,
  },
  modalCard: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    maxHeight: "80%",
    overflow: "hidden",
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  modalTitle: {
    fontSize: fontSize.md,
    fontWeight: "700",
    color: colors.text,
  },
  modalSearchBox: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    height: 40,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
  },
  modalSearchInput: {
    flex: 1,
    marginLeft: spacing.sm,
    fontSize: fontSize.sm,
    color: colors.text,
  },
  modalList: {
    paddingHorizontal: spacing.sm,
    paddingBottom: spacing.sm,
  },
  modalRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    marginHorizontal: spacing.xs,
  },
  modalRowActive: {
    backgroundColor: "#E6F9F1",
  },
  modalRowText: {
    flex: 1,
    fontSize: fontSize.sm,
    color: colors.text,
    fontWeight: "500",
  },
  modalRowTextActive: {
    color: colors.brand,
    fontWeight: "700",
  },
  modalEmpty: {
    textAlign: "center",
    color: colors.textTertiary,
    fontSize: fontSize.sm,
    padding: spacing.lg,
  },

  // Results count
  resultsRow: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xs,
  },
  resultsText: {
    fontSize: fontSize.xs,
    color: colors.textTertiary,
    fontWeight: "500",
  },

  // List
  listContent: { padding: spacing.lg, gap: spacing.md },
  tabletListContent: { maxWidth: 900, alignSelf: "center", width: "100%" },

  // Card
  card: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.xs,
  },
  tabletCard: { marginHorizontal: 0 },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  cardTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    flex: 1,
    marginRight: spacing.sm,
  },
  sampleId: { fontSize: fontSize.sm, fontWeight: "700", color: colors.text, flex: 1 },
  detailGrid: {
    marginTop: spacing.xs,
    gap: 2,
  },
  detailLine: {
    fontSize: fontSize.xs,
    color: colors.textSecondary,
  },
  detailLabel: {
    color: colors.text,
    fontWeight: "600",
  },
  cardFooter: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: spacing.sm,
    gap: spacing.sm,
  },
  versionBadge: {
    backgroundColor: colors.bg,
    borderRadius: radius.sm,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: colors.border,
  },
  versionText: { fontSize: fontSize.xs, color: colors.textTertiary, fontWeight: "500" },

  // Empty state
  empty: { alignItems: "center", marginTop: 80, gap: spacing.sm },
  emptyTitle: { fontSize: fontSize.md, fontWeight: "600", color: colors.textSecondary, marginTop: spacing.sm },
  emptySubtitle: { fontSize: fontSize.xs, color: colors.textTertiary, textAlign: "center" },
});
