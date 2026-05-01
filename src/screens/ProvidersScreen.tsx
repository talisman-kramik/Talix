/**
 * Providers list screen.
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
  ActivityIndicator,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";

import Badge from "../components/Badge";
import { colors, fontSize, spacing, radius } from "../lib/theme";
import { fetchProviders, type ProviderSummary } from "../lib/api";
import { useSettings } from "../store/settings";

export default function ProvidersScreen() {
  const { width } = useWindowDimensions();
  const isTablet = width >= 768;
  const numColumns = isTablet ? 2 : 1;
  const apiUrl = useSettings((s) => s.apiUrl);

  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const load = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const ps = await fetchProviders();
      setProviders(ps);
    } catch (err) {
      setProviders([]);
      setLoadError(err instanceof Error ? err.message : "Failed to load providers");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, apiUrl]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load().catch(() => {});
    setRefreshing(false);
  };

  const filteredProviders = providers.filter((p) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      (p.name && p.name.toLowerCase().includes(q)) ||
      p.id.toLowerCase().includes(q)
    );
  });

  const renderItem = ({ item }: { item: ProviderSummary }) => {
    const isExpanded = expandedId === item.id;
    const score = item.latest_score;
    const scoreVariant = () => {
      if (score == null) return "neutral" as const;
      if (score >= 4.5) return "success" as const;
      if (score >= 4.0) return "info" as const;
      return "warning" as const;
    };

    return (
      <TouchableOpacity
        style={[styles.card, isTablet && styles.tabletCard, isExpanded && styles.cardExpanded]}
        activeOpacity={0.7}
        onPress={() => setExpandedId(isExpanded ? null : item.id)}
      >
        <View style={styles.cardTop}>
          <View style={styles.avatar}>
            <Ionicons name="person" size={22} color={colors.brand} />
          </View>
          <View style={{ flex: 1, marginLeft: spacing.md }}>
            <Text style={styles.name}>{item.name ?? item.id}</Text>
            {item.credentials && (
              <Text style={styles.credentials}>{item.credentials}</Text>
            )}
            {!item.credentials && (
              <Text style={styles.credentials}>Tap to view provider details</Text>
            )}
          </View>
          <Ionicons
            name={isExpanded ? "chevron-up" : "chevron-down"}
            size={20}
            color={colors.textTertiary}
          />
        </View>

        {isExpanded && (
          <View style={styles.expandedDetails}>
            <Text style={styles.detailText}><Text style={styles.detailLabel}>Provider ID:</Text> {item.id}</Text>
            <Text style={styles.detailText}>
              <Text style={styles.detailLabel}>Credentials:</Text> {item.credentials || "Not available"}
            </Text>
            <Text style={styles.detailText}>
              <Text style={styles.detailLabel}>Specialty:</Text> {item.specialty || "Not available"}
            </Text>
            <Text style={styles.detailText}>
              <Text style={styles.detailLabel}>Overall Quality Score:</Text>{" "}
              {score != null ? score.toFixed(2) : "Not available"}
            </Text>
            <Text style={styles.detailText}>
              <Text style={styles.detailLabel}>Tracked Versions:</Text>{" "}
              {Object.keys(item.quality_scores).length}
            </Text>
          </View>
        )}

        <View style={styles.cardMeta}>
          {item.specialty && !isExpanded && <Badge label={item.specialty} variant="info" />}
          {score != null && !isExpanded && (
            <Badge label={`Quality: ${score.toFixed(2)}`} variant={scoreVariant()} />
          )}
        </View>

        {/* Version scores */}
        {Object.keys(item.quality_scores).length > 0 && isExpanded && (
          <View style={styles.scoresRow}>
            {Object.entries(item.quality_scores)
              .sort(([a], [b]) => a.localeCompare(b))
              .slice(-4)
              .map(([ver, s]) => (
                <View key={ver} style={styles.scorePill}>
                  <Text style={styles.scoreVersion}>{ver}</Text>
                  <Text style={styles.scoreNum}>{s.toFixed(2)}</Text>
                </View>
              ))}
          </View>
        )}
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.topSection}>
        <View style={styles.searchBox}>
          <Ionicons name="search" size={16} color={colors.textTertiary} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search providers by name or ID..."
            style={styles.searchInput}
            placeholderTextColor={colors.textTertiary}
          />
          {search.length > 0 && (
            <TouchableOpacity onPress={() => setSearch("")}>
              <Ionicons name="close-circle" size={16} color={colors.textTertiary} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      <FlatList
        data={filteredProviders}
        keyExtractor={(p) => p.id}
        renderItem={renderItem}
        numColumns={numColumns}
        key={numColumns}
        contentContainerStyle={[styles.listContent, isTablet && styles.tabletListContent]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.brand} />}
        ListEmptyComponent={
          <View style={styles.empty}>
            {isLoading ? (
              <>
                <ActivityIndicator size="small" color={colors.brand} />
                <Text style={styles.emptyText}>Loading providers...</Text>
              </>
            ) : (
              <>
                <Ionicons name="people-outline" size={40} color={colors.textTertiary} />
                <Text style={styles.emptyText}>{loadError ? `Unable to load providers: ${loadError}` : "No providers found"}</Text>
              </>
            )}
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  topSection: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
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
  listContent: { padding: spacing.lg, gap: spacing.md },
  tabletListContent: { maxWidth: 900, alignSelf: "center", width: "100%" },
  card: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardExpanded: {
    borderColor: colors.brand,
    backgroundColor: "#F0FDF4",
  },
  tabletCard: { marginHorizontal: spacing.xs },
  cardTop: { flexDirection: "row", alignItems: "center" },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#D1FAE5",
    alignItems: "center",
    justifyContent: "center",
  },
  name: { fontSize: fontSize.md, fontWeight: "600", color: colors.text },
  credentials: { fontSize: fontSize.xs, color: colors.textSecondary },
  expandedDetails: {
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.borderLight,
    gap: 4,
  },
  detailText: {
    fontSize: fontSize.sm,
    color: colors.text,
  },
  detailLabel: {
    fontWeight: "600",
    color: colors.textSecondary,
  },
  cardMeta: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.md },
  scoresRow: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.md, flexWrap: "wrap" },
  scorePill: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.borderLight,
    borderRadius: radius.full,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    gap: spacing.xs,
  },
  scoreVersion: { fontSize: fontSize.xs, color: colors.textTertiary, fontWeight: "500" },
  scoreNum: { fontSize: fontSize.xs, color: colors.text, fontWeight: "600" },
  empty: { alignItems: "center", marginTop: 80 },
  emptyText: { fontSize: fontSize.sm, color: colors.textTertiary, marginTop: spacing.md },
});
