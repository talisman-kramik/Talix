/**
 * Renders an amendment diff as inline text with green inserts and red
 * strike-through deletes, grouped by change region with surrounding context.
 *
 * Visual language mirrors the web `DiffRenderer.vue` so providers see the
 * same colour cues on phone and web.
 */
import React, { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";

import type { AmendDiffChunk } from "../lib/amendService";
import { buildDiffGroups } from "../lib/diffFormatter";
import { colors, fontSize, radius, spacing } from "../lib/theme";

interface Props {
  diff: AmendDiffChunk[];
}

export default function SmartEditDiffView({ diff }: Props) {
  const groups = useMemo(() => buildDiffGroups(diff), [diff]);

  if (groups.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>No changes detected.</Text>
      </View>
    );
  }

  return (
    <View>
      {groups.map((group, gi) => (
        <View key={gi} style={styles.group}>
          {group.before ? (
            <Text style={[styles.line, styles.context]}>{group.before}</Text>
          ) : null}
          <Text style={styles.line}>
            {group.changes.map((entry, ei) => {
              if (entry.type === "insert") {
                return (
                  <Text key={ei} style={styles.insert}>
                    {entry.text}
                  </Text>
                );
              }
              if (entry.type === "delete") {
                return (
                  <Text key={ei} style={styles.delete}>
                    {entry.text}
                  </Text>
                );
              }
              return (
                <Text key={ei} style={styles.equal}>
                  {entry.text}
                </Text>
              );
            })}
          </Text>
          {group.after ? (
            <Text style={[styles.line, styles.context]}>{group.after}</Text>
          ) : null}
          {gi < groups.length - 1 ? (
            <Text style={styles.separator}>· · ·</Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  group: {
    marginBottom: spacing.sm,
  },
  line: {
    fontSize: fontSize.sm,
    lineHeight: 22,
    color: colors.text,
  },
  context: {
    color: colors.textSecondary,
    fontSize: 13,
  },
  equal: {
    color: colors.text,
  },
  insert: {
    color: "#1B5E20",
    backgroundColor: "#E6FFEC",
    borderRadius: radius.sm,
    fontWeight: "500",
    paddingHorizontal: 4,
  },
  delete: {
    color: "#C62828",
    backgroundColor: "#FFEBE9",
    borderRadius: radius.sm,
    textDecorationLine: "line-through",
    paddingHorizontal: 4,
  },
  separator: {
    textAlign: "center",
    color: colors.textTertiary,
    letterSpacing: 4,
    fontSize: 16,
    paddingVertical: spacing.sm,
  },
  empty: {
    paddingVertical: spacing.xl,
    alignItems: "center",
  },
  emptyText: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  },
});
