/**
 * Non-dismissible banner shown when an encounter has been modified on the web.
 * Displays for statuses: "Provider Edited", "Provider Reviewed", "MT Reviewed".
 */
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { colors, fontSize, spacing, radius } from "../lib/theme";
import type { WebStatus } from "../lib/api";

/** Statuses that trigger the banner display */
const BANNER_STATUSES = ["Provider Edited", "Provider Reviewed", "MT Reviewed"] as const;

interface WebStatusBannerProps {
  webStatus: WebStatus | null;
}

/**
 * Determines whether the banner should be shown based on the web status.
 * Returns true only when webStatus is non-null and its status field matches
 * one of the recognized banner statuses.
 */
export function shouldShowBanner(webStatus: WebStatus | null): boolean {
  if (!webStatus) return false;
  return (BANNER_STATUSES as readonly string[]).includes(webStatus.status);
}

export default function WebStatusBanner({ webStatus }: WebStatusBannerProps) {
  if (!shouldShowBanner(webStatus)) return null;

  return (
    <View style={styles.banner}>
      <Ionicons name="information-circle" size={18} color={colors.warning} />
      <Text style={styles.bannerText}>
        This encounter has been modified on the web. Please refer to the web app for the latest version.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#FEF3C7",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: "#FDE68A",
    gap: spacing.sm,
  },
  bannerText: {
    flex: 1,
    fontSize: fontSize.sm,
    color: "#92400E",
    lineHeight: 18,
  },
});
