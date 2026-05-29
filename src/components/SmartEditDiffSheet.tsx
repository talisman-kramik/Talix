/**
 * Smart Edit review modal — shows the diff returned by the middleware and
 * captures the provider's Accept / Reject / Revise decision. Accept uses a
 * two-step confirmation overlay so a stray tap can't commit a new version
 * silently.
 *
 * Visibility is driven by the lifecycle phase rather than a separate `open`
 * prop — when phase is `diff_preview` or `confirming` the sheet is shown.
 */
import React from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { colors, fontSize, radius, spacing } from "../lib/theme";
import type { AmendLifecycle } from "../hooks/useAmendLifecycle";
import SmartEditDiffView from "./SmartEditDiffView";
import { diffHasChanges } from "../lib/diffFormatter";

interface Props {
  lifecycle: AmendLifecycle;
  onAccepted: (payload: { amendedNote: string; newVersion: string }) => void;
  onRejected: () => void;
  onRevise: () => void;
}

export default function SmartEditDiffSheet({
  lifecycle,
  onAccepted,
  onRejected,
  onRevise,
}: Props) {
  const visible =
    lifecycle.phase === "diff_preview" || lifecycle.phase === "confirming";

  const diff = lifecycle.diffResult ?? [];
  const hasContent = diffHasChanges(diff);

  const handleConfirmAccept = () => {
    const payload = lifecycle.confirmAccept();
    if (payload) onAccepted(payload);
  };

  const handleReject = () => {
    lifecycle.reject();
    onRejected();
  };

  const handleRevise = () => {
    lifecycle.revise();
    onRevise();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={handleReject}
    >
      <View style={styles.backdrop}>
        <View style={styles.card}>
          {/* Header */}
          <View style={styles.header}>
            <Ionicons name="git-compare-outline" size={20} color={colors.textInverse} />
            <View style={{ flex: 1, marginLeft: spacing.sm }}>
              <Text style={styles.headerTitle}>Review Changes</Text>
              <Text style={styles.headerSub}>
                Verify the suggested edits before applying them.
              </Text>
            </View>
            <Pressable onPress={handleReject} hitSlop={8}>
              <Ionicons name="close" size={20} color={colors.textInverse} />
            </Pressable>
          </View>

          {/* What was requested */}
          {lifecycle.submittedInput ? (
            <View style={styles.requestedRow}>
              <Ionicons
                name={lifecycle.submittedVia === "voice" ? "mic" : "create-outline"}
                size={14}
                color={colors.textSecondary}
              />
              {lifecycle.submittedVia === "voice" ? (
                <Text style={styles.requestedLabel}>
                  Submitted via voice recording
                </Text>
              ) : (
                <Text style={styles.requestedLabel} numberOfLines={3}>
                  <Text style={styles.requestedLabelBold}>Your instruction: </Text>
                  <Text style={styles.requestedItalic}>
                    “{lifecycle.submittedInput}”
                  </Text>
                </Text>
              )}
            </View>
          ) : null}

          {/* Legend */}
          {hasContent ? (
            <View style={styles.legendRow}>
              <View style={styles.legendItem}>
                <View style={[styles.legendSwatch, styles.legendAdded]} />
                <Text style={styles.legendText}>Added</Text>
              </View>
              <View style={styles.legendItem}>
                <View style={[styles.legendSwatch, styles.legendRemoved]} />
                <Text style={styles.legendText}>Removed</Text>
              </View>
            </View>
          ) : null}

          {/* Body */}
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator
          >
            {hasContent ? (
              <View style={styles.diffCard}>
                <SmartEditDiffView diff={diff} />
              </View>
            ) : (
              <View style={styles.emptyState}>
                <Ionicons
                  name="hourglass-outline"
                  size={48}
                  color={colors.textTertiary}
                />
                <Text style={styles.emptyTitle}>No changes to display</Text>
                <Text style={styles.emptySub}>
                  The request may have returned no differences. Try revising the
                  instruction.
                </Text>
              </View>
            )}
          </ScrollView>

          {/* Confirmation overlay */}
          {lifecycle.phase === "confirming" ? (
            <View style={styles.confirmRow}>
              <View style={styles.confirmText}>
                <Ionicons name="information-circle" size={18} color={colors.brand} />
                <Text style={styles.confirmCopy}>
                  Accepting will save the amended note as a new version.
                </Text>
              </View>
              <View style={styles.actionsRow}>
                <Pressable
                  style={[styles.btn, styles.btnGhost]}
                  onPress={lifecycle.cancelConfirm}
                >
                  <Text style={styles.btnGhostText}>Go Back</Text>
                </Pressable>
                <Pressable
                  style={[styles.btn, styles.btnPrimary]}
                  onPress={handleConfirmAccept}
                >
                  <Ionicons name="checkmark" size={16} color={colors.textInverse} />
                  <Text style={styles.btnPrimaryText}>Confirm &amp; Save</Text>
                </Pressable>
              </View>
            </View>
          ) : (
            <View style={styles.footer}>
              {hasContent ? (
                <>
                  <Pressable
                    style={[styles.btn, styles.btnGhost]}
                    onPress={handleReject}
                  >
                    <Ionicons name="close" size={16} color={colors.textSecondary} />
                    <Text style={styles.btnGhostText}>Reject</Text>
                  </Pressable>
                  <View style={{ flex: 1 }} />
                  <Pressable
                    style={[styles.btn, styles.btnOutline]}
                    onPress={handleRevise}
                  >
                    <Ionicons name="create-outline" size={16} color={colors.brand} />
                    <Text style={styles.btnOutlineText}>Revise</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.btn, styles.btnPrimary]}
                    onPress={lifecycle.acceptClick}
                  >
                    <Ionicons name="checkmark" size={16} color={colors.textInverse} />
                    <Text style={styles.btnPrimaryText}>Accept Changes</Text>
                  </Pressable>
                </>
              ) : (
                <>
                  <Pressable
                    style={[styles.btn, styles.btnGhost]}
                    onPress={handleReject}
                  >
                    <Ionicons name="close" size={16} color={colors.textSecondary} />
                    <Text style={styles.btnGhostText}>Close</Text>
                  </Pressable>
                  <View style={{ flex: 1 }} />
                  <Pressable
                    style={[styles.btn, styles.btnOutline]}
                    onPress={handleRevise}
                  >
                    <Ionicons name="refresh" size={16} color={colors.brand} />
                    <Text style={styles.btnOutlineText}>Try Again</Text>
                  </Pressable>
                </>
              )}
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.45)",
    justifyContent: "center",
    paddingHorizontal: spacing.md,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    overflow: "hidden",
    maxHeight: "90%",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.brand,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  headerTitle: {
    color: colors.textInverse,
    fontSize: fontSize.lg,
    fontWeight: "700",
  },
  headerSub: {
    color: "rgba(255,255,255,0.85)",
    fontSize: 12,
    marginTop: 2,
  },
  requestedRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.borderLight,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  requestedLabel: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: 12,
  },
  requestedLabelBold: {
    fontWeight: "600",
    color: colors.textSecondary,
  },
  requestedItalic: {
    color: colors.text,
    fontStyle: "italic",
  },
  legendRow: {
    flexDirection: "row",
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
  },
  legendItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  legendSwatch: {
    width: 14,
    height: 14,
    borderRadius: 3,
    borderWidth: 1,
  },
  legendAdded: {
    backgroundColor: "#E6FFEC",
    borderColor: "#4CAF50",
  },
  legendRemoved: {
    backgroundColor: "#FFEBE9",
    borderColor: "#F44336",
  },
  legendText: {
    color: colors.textSecondary,
    fontSize: 12,
  },
  scroll: {
    flexGrow: 0,
  },
  scrollContent: {
    padding: spacing.md,
  },
  diffCard: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    backgroundColor: "#FAFBFC",
    minHeight: 160,
  },
  emptyState: {
    alignItems: "center",
    paddingVertical: spacing.xxxl,
    gap: spacing.sm,
  },
  emptyTitle: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: "600",
  },
  emptySub: {
    color: colors.textSecondary,
    fontSize: 12,
    textAlign: "center",
    paddingHorizontal: spacing.lg,
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  confirmRow: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: "#EFF6FF",
  },
  confirmText: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: spacing.md,
  },
  confirmCopy: {
    flex: 1,
    color: colors.text,
    fontSize: fontSize.sm,
  },
  actionsRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: spacing.sm,
  },
  btn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
  },
  btnGhost: {
    backgroundColor: "transparent",
  },
  btnGhostText: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: "600",
  },
  btnOutline: {
    borderWidth: 1,
    borderColor: colors.brand,
    backgroundColor: colors.card,
  },
  btnOutlineText: {
    color: colors.brand,
    fontSize: fontSize.sm,
    fontWeight: "600",
  },
  btnPrimary: {
    backgroundColor: colors.brand,
  },
  btnPrimaryText: {
    color: colors.textInverse,
    fontSize: fontSize.sm,
    fontWeight: "700",
  },
});
