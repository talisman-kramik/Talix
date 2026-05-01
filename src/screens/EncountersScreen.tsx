/**
 * Encounters list — shows all samples with provider filter and status badges.
 * Redesigned with fixed chip heights and proper layout.
 */
import React, { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  useWindowDimensions,
  TextInput,
  ScrollView,
  ActivityIndicator,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";

import Badge from "../components/Badge";
import { colors, fontSize, spacing, radius } from "../lib/theme";
import { fetchSamples, fetchProviders, type SampleSummary, type ProviderSummary } from "../lib/api";
import { useSettings } from "../store/settings";

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

export default function EncountersScreen() {
  const nav = useNavigation<any>();
  const { width } = useWindowDimensions();
  const isTablet = width >= 768;
  const numColumns = isTablet ? 2 : 1;
  const apiUrl = useSettings((s) => s.apiUrl);

  const [samples, setSamples] = useState<SampleSummary[]>([]);
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [filterProvider, setFilterProvider] = useState<string | null>(null);
  const [filterMode, setFilterMode] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const [s, p] = await Promise.all([fetchSamples(), fetchProviders()]);
      setSamples(s);
      setProviders(p);
    } catch (err) {
      console.warn("Failed to load encounters data", err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData, apiUrl]);

  const onRefresh = async () => {
    setRefreshing(true);
    await loadData().catch(() => {});
    setRefreshing(false);
  };

  const selectedProviderObj = providers.find(p => p.id === filterProvider);

  const filtered = samples.filter((s) => {
    if (selectedProviderObj) {
      const pName = selectedProviderObj.name;
      const matchName = pName && s.physician === pName;
      const matchId = s.physician === selectedProviderObj.id;
      if (!matchName && !matchId) return false;
    }
    if (filterMode && s.mode !== filterMode) return false;
    if (search && !s.sample_id.toLowerCase().includes(search.toLowerCase())) return false;
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

        <Text style={styles.physician} numberOfLines={1}>{item.physician}</Text>

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
            placeholder="Search encounters..."
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
          <ModeChip label="Ambient" value="ambient" />
        </View>
      </View>

      {/* Provider filter — horizontal scroll */}
      {providers.length > 0 && (
        <View style={styles.providerSection}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.providerScrollContent}
          >
            <TouchableOpacity
              style={[styles.providerChip, filterProvider === null && styles.providerChipActive]}
              onPress={() => setFilterProvider(null)}
              activeOpacity={0.7}
            >
              <Ionicons
                name="people"
                size={12}
                color={filterProvider === null ? colors.textInverse : colors.textSecondary}
              />
              <Text style={[styles.providerChipText, filterProvider === null && styles.providerChipTextActive]}>
                All Providers
              </Text>
            </TouchableOpacity>

            {providers.map((p) => {
              const active = filterProvider === p.id;
              return (
                <TouchableOpacity
                  key={p.id}
                  style={[styles.providerChip, active && styles.providerChipActive]}
                  onPress={() => setFilterProvider(active ? null : p.id)}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.providerChipText, active && styles.providerChipTextActive]} numberOfLines={1}>
                    {p.name ?? p.id}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      )}

      {/* Results count */}
      <View style={styles.resultsRow}>
        <Text style={styles.resultsText}>
          {filtered.length} encounter{filtered.length !== 1 ? "s" : ""}
        </Text>
      </View>

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
              <Text style={styles.emptyTitle}>Loading encounters...</Text>
            </View>
          ) : (
            <View style={styles.empty}>
              <Ionicons name="document-text-outline" size={48} color={colors.textTertiary} />
              <Text style={styles.emptyTitle}>No encounters found</Text>
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

  // Provider chips
  providerSection: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingVertical: spacing.sm,
  },
  providerScrollContent: {
    paddingHorizontal: spacing.lg,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  providerChip: {
    height: CHIP_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingHorizontal: spacing.md,
    borderRadius: CHIP_HEIGHT / 2,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  providerChipActive: {
    backgroundColor: colors.brand,
    borderColor: colors.brand,
  },
  providerChipText: {
    fontSize: fontSize.xs,
    fontWeight: "600",
    color: colors.textSecondary,
    maxWidth: 120,
  },
  providerChipTextActive: {
    color: "#FFFFFF",
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
  tabletCard: { marginHorizontal: spacing.xs },
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
  physician: { fontSize: fontSize.xs, color: colors.textSecondary, marginTop: 2 },
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
