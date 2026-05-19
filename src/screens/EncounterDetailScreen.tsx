/**
 * SOAP Note detail — patient / provider / note metadata + clinical note.
 *
 * Layout (per QA item #13): rather than repeating patient + provider fields
 * inline with the title, we render three clean sectioned cards followed by
 * the actual note content:
 *
 *   1. Patient Details
 *   2. Provider Details
 *   3. SOAP Note (id, mode, quality)
 *   4. Markdown body
 */
import React, { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  useWindowDimensions,
} from "react-native";
import Markdown from "react-native-markdown-display";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "@react-navigation/native";

import { colors, fontSize, spacing, radius } from "../lib/theme";
import Badge from "../components/Badge";
import WebStatusBanner from "../components/WebStatusBanner";
import {
  fetchSample,
  fetchNote,
  fetchWebStatus,
  type SampleDetail,
  type WebStatus,
} from "../lib/api";
import { formatDateUS } from "../lib/date";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toTitleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Provider names sometimes arrive as raw slugs ("dr_adam_thompson"). Strip
 * the honorific prefix and normalise to title case for display.
 */
function prettifyProviderName(raw?: string | null): string {
  if (!raw) return "—";
  let cleaned = raw.replace(/^dr[_\s.]+/i, "").replace(/[_]+/g, " ").trim();
  cleaned = cleaned.replace(/\s+/g, " ");
  return cleaned ? toTitleCase(cleaned) : raw;
}

/**
 * Derive a human patient name from a sample_id like
 * "cynthia_silver_7802797_2026-05-15" → "Cynthia Silver".
 *
 * Sample IDs encode the patient name as the leading underscore-separated
 * tokens, followed by numeric / date tokens. We grab the first two such
 * non-numeric, non-date tokens (or whatever the schema gives us when there
 * are fewer) and title-case them.
 */
function derivePatientNameFromSampleId(sampleId: string): string | null {
  if (!sampleId) return null;
  const tokens = sampleId.split("_").filter(Boolean);
  const nameTokens: string[] = [];
  for (const tok of tokens) {
    // Stop once we hit a numeric chunk, a date, or an obviously non-name token.
    if (/^\d+/.test(tok)) break;
    if (/^\d{4}-\d{2}-\d{2}$/.test(tok)) break;
    if (/[.]/.test(tok)) break; // tokens like "Excelsia_..." with dots
    nameTokens.push(tok);
    if (nameTokens.length >= 2) break;
  }
  if (nameTokens.length === 0) return null;
  return toTitleCase(nameTokens.join(" "));
}

/**
 * The AI-generated note often begins with a preamble block that duplicates
 * data we already render in the structured cards above, e.g.:
 *
 *   # Clinical Note — deisy_acosta_8607.2.Excelsia_...
 *   **Provider:** Adam Thompson | **Specialty:** General
 *   ---
 *   Chief Complaint
 *   ...
 *
 * This helper strips that preamble (and a few pipeline metadata lines) so
 * the rendered note starts directly with the first real SOAP section.
 */
function sanitizeNoteContent(content: string | null): string | null {
  if (!content) return content;

  let lines = content.split("\n");

  // Detect a preamble that contains the redundant "Clinical Note —" heading
  // and / or an inline Provider | Specialty line, then drop everything up to
  // and including the first horizontal rule that closes the preamble.
  const PREAMBLE_LOOKAHEAD = 15;
  const hrIndex = (() => {
    for (let i = 0; i < Math.min(lines.length, PREAMBLE_LOOKAHEAD); i++) {
      if (/^-{3,}\s*$/.test(lines[i].trim())) return i;
    }
    return -1;
  })();
  if (hrIndex >= 0) {
    const preamble = lines.slice(0, hrIndex).join("\n");
    const looksLikePreamble =
      /Clinical Note\s*[—-]/i.test(preamble) ||
      /\*\*Provider:\*\*/i.test(preamble) ||
      /^Provider:.*Specialty:/im.test(preamble);
    if (looksLikePreamble) {
      lines = lines.slice(hrIndex + 1);
    }
  }

  return lines
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      if (/^\*?AI Scribe\s+v\d+/i.test(trimmed)) return false;
      if (/^\*\*?Pipeline Version:/i.test(trimmed)) return false;
      if (/^\*\*?ASR:/i.test(trimmed)) return false;
      // Defensive: drop any stragglers from the preamble that survived the
      // block strip above (e.g. when the note has no horizontal rule).
      if (/^#+\s*Clinical Note\s*[—-]/i.test(trimmed)) return false;
      if (/^Clinical Note\s*[—-]/i.test(trimmed)) return false;
      if (/^\*\*Provider:\*\*.*\*\*Specialty:\*\*/i.test(trimmed)) return false;
      if (/^Provider:.*\|\s*Specialty:/i.test(trimmed)) return false;
      return true;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Reusable sub-components
// ---------------------------------------------------------------------------

type FieldRowProps = {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string;
  /** Render value in a smaller mono-style font (used for note IDs). */
  mono?: boolean;
};

function FieldRow({ icon, label, value, mono }: FieldRowProps) {
  return (
    <View style={styles.fieldRow}>
      <View style={styles.fieldIconWrap}>
        <Ionicons name={icon} size={16} color={colors.textSecondary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.fieldLabel}>{label}</Text>
        <Text
          style={[styles.fieldValue, mono && styles.fieldValueMono]}
          numberOfLines={mono ? 3 : 2}
        >
          {value}
        </Text>
      </View>
    </View>
  );
}

type SectionProps = {
  title: string;
  children: React.ReactNode;
};

function Section({ title, children }: SectionProps) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionCard}>{children}</View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function EncounterDetailScreen({ route }: any) {
  const { sampleId } = route.params as { sampleId: string };
  const { width } = useWindowDimensions();
  const isTablet = width >= 768;

  const [sample, setSample] = useState<SampleDetail | null>(null);
  const [noteContent, setNoteContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [webStatus, setWebStatus] = useState<WebStatus | null>(null);

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sampleId]);

  // Non-blocking web-status fetch: fires on screen focus (mount, foreground, nav back)
  useFocusEffect(
    useCallback(() => {
      let isActive = true;

      const loadWebStatus = async () => {
        try {
          const status = await fetchWebStatus(sampleId);
          if (isActive) {
            setWebStatus(status);
          }
        } catch {
          // Silent suppression: network error, timeout, non-200/non-404 → no banner
          if (isActive) {
            setWebStatus(null);
          }
        }
      };

      loadWebStatus();

      return () => {
        isActive = false;
      };
    }, [sampleId])
  );

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const s = await fetchSample(sampleId);
      setSample(s);

      const version = s.latest_version ?? undefined;
      const noteRes = await fetchNote(sampleId, version);
      setNoteContent(noteRes.content);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load SOAP note");
    }
    setLoading(false);
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.brand} />
      </View>
    );
  }

  if (error || !sample) {
    return (
      <View style={styles.centered}>
        <Ionicons name="alert-circle-outline" size={40} color={colors.error} />
        <Text style={styles.errorText}>{error ?? "Not found"}</Text>
      </View>
    );
  }

  const patient = sample.patient_context?.patient;
  const provider = sample.patient_context?.provider;

  // Prefer the structured patient_context provider name, fall back to the
  // raw `physician` field on the encounter.
  const providerName = prettifyProviderName(provider?.name ?? sample.physician);

  // Specialty: only show the row when we actually have data. Many older
  // notes don't have provider.specialty populated, so we'd rather hide the
  // row than render a placeholder "—".
  const specialty = (provider?.specialty ?? "").trim();

  // Patient name: prefer the structured patient_context value, otherwise
  // derive a readable name from the sample_id ("cynthia_silver_..." →
  // "Cynthia Silver"). Avoids the lonely "—" when the AI pipeline didn't
  // attach full patient context.
  const patientName =
    patient?.name?.trim() ||
    derivePatientNameFromSampleId(sample.sample_id) ||
    "—";

  const score = sample.quality?.overall;
  const modeLabel = sample.mode === "ambient" ? "Conversation" : "Dictation";
  const displayNoteContent = sanitizeNoteContent(noteContent);

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[
        styles.contentContainer,
        isTablet && styles.tabletContent,
      ]}
    >
      {/* Patient Details */}
      <Section title="Patient Details">
        <FieldRow icon="person-outline" label="Patient Name" value={patientName} />
        {patient?.date_of_birth ? (
          <FieldRow
            icon="calendar-outline"
            label="Date of Birth"
            value={formatDateUS(patient.date_of_birth)}
          />
        ) : null}
        {patient?.sex || patient?.age != null ? (
          <FieldRow
            icon="information-circle-outline"
            label="Demographics"
            value={[patient?.sex, patient?.age != null ? `${patient.age} yrs` : null]
              .filter(Boolean)
              .join(" · ")}
          />
        ) : null}
        {patient?.mrn ? (
          <FieldRow
            icon="card-outline"
            label="MRN"
            value={patient.mrn}
            mono
          />
        ) : null}
      </Section>

      {/* Provider Details */}
      <Section title="Provider Details">
        <FieldRow icon="person-outline" label="Provider" value={providerName} />
        {specialty ? (
          <FieldRow icon="medkit-outline" label="Specialty" value={specialty} />
        ) : null}
      </Section>

      {/* SOAP Note metadata */}
      <Section title="SOAP Note">
        <View style={styles.fieldRow}>
          <View style={styles.fieldIconWrap}>
            <Ionicons name="document-text-outline" size={16} color={colors.brand} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.fieldLabel}>Note ID</Text>
            <Text style={styles.fieldValueMono} numberOfLines={3}>
              {sample.sample_id}
            </Text>
          </View>
        </View>

        {/* Web-status banner (non-dismissible) */}
        <WebStatusBanner webStatus={webStatus} />

        <View style={styles.metaInline}>
          <Badge
            label={modeLabel}
            variant={sample.mode === "dictation" ? "info" : "success"}
          />
          {score != null ? (
            <Text style={styles.qualityText}>
              Quality:{" "}
              <Text
                style={{
                  color: score >= 4.0 ? colors.brand : colors.warning,
                  fontWeight: "700",
                }}
              >
                {score.toFixed(2)}
              </Text>
            </Text>
          ) : null}
        </View>
      </Section>

      {/* Note body */}
      <View style={styles.noteBody}>
        {displayNoteContent ? (
          <Markdown style={markdownStyles}>{displayNoteContent}</Markdown>
        ) : (
          <Text style={styles.emptyContent}>No note available</Text>
        )}
      </View>
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const markdownStyles = StyleSheet.create({
  heading1: { fontSize: fontSize.xl, fontWeight: "700", color: colors.text, marginBottom: spacing.sm, marginTop: spacing.lg },
  heading2: { fontSize: fontSize.lg, fontWeight: "700", color: colors.text, marginBottom: spacing.sm, marginTop: spacing.lg },
  heading3: { fontSize: fontSize.md, fontWeight: "600", color: colors.text, marginBottom: spacing.xs, marginTop: spacing.md },
  paragraph: { fontSize: fontSize.sm, color: colors.text, lineHeight: 22 },
  strong: { fontWeight: "700" },
  listItem: { fontSize: fontSize.sm, color: colors.text },
  hr: { borderColor: colors.border, marginVertical: spacing.lg },
  body: {},
  bullet_list: {},
  ordered_list: {},
  list_item: {},
  link: {},
  blockquote: {},
  code_inline: {},
  code_block: {},
  fence: {},
  table: {},
  thead: {},
  tbody: {},
  th: {},
  tr: {},
  td: {},
  image: {},
  text: {},
  textgroup: {},
  hardbreak: {},
  softbreak: {},
  pre: {},
  inline: {},
  span: {},
  s: {},
  em: {},
});

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  centered: { flex: 1, justifyContent: "center", alignItems: "center", padding: spacing.lg },
  errorText: { fontSize: fontSize.sm, color: colors.error, marginTop: spacing.md, textAlign: "center" },

  contentContainer: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xxl,
    gap: spacing.lg,
  },
  tabletContent: { maxWidth: 900, alignSelf: "center", width: "100%" },

  section: {
    gap: spacing.sm,
  },
  sectionTitle: {
    fontSize: fontSize.lg,
    fontWeight: "700",
    color: colors.text,
  },
  sectionCard: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },

  fieldRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  fieldIconWrap: {
    width: 28,
    height: 28,
    borderRadius: radius.sm,
    backgroundColor: colors.bg,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 2,
  },
  fieldLabel: {
    fontSize: fontSize.xs,
    color: colors.textSecondary,
    fontWeight: "500",
  },
  fieldValue: {
    fontSize: fontSize.md,
    color: colors.text,
    fontWeight: "600",
    marginTop: 2,
  },
  fieldValueMono: {
    fontSize: fontSize.sm,
    fontVariant: ["tabular-nums"],
    fontWeight: "500",
  },

  metaInline: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    marginTop: spacing.xs,
  },
  qualityText: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
  },

  noteBody: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  emptyContent: {
    fontSize: fontSize.sm,
    color: colors.textTertiary,
    textAlign: "center",
    paddingVertical: spacing.xl,
  },
});
