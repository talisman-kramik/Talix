/**
 * Smart Edits side panel — Quick Edits shortcuts + custom text/voice request.
 * Layout mirrors the web Smart Edits UI (reference screenshots).
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { colors, fontSize, radius, spacing } from "../lib/theme";
import type { AmendLifecycle } from "../hooks/useAmendLifecycle";
import type { AmendVoiceRecorder } from "../hooks/useAmendVoiceRecorder";
import {
  extractNoteSections,
  QUICK_EDIT_ACCORDIONS,
  QUICK_EDIT_ACTIONS,
  type QuickEditAccordion,
} from "../lib/quickEditPresets";

interface Props {
  visible: boolean;
  onClose: () => void;
  lifecycle: AmendLifecycle;
  recorder: AmendVoiceRecorder;
  encounterId: string;
  currentVersion: string | null;
  providerId?: string | null;
  baseNote: string | null;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function SmartEditPanel({
  visible,
  onClose,
  lifecycle,
  recorder,
  encounterId,
  currentVersion,
  providerId,
  baseNote,
}: Props) {
  const { width } = useWindowDimensions();
  const isTablet = width >= 768;
  const [text, setText] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const noteSections = useMemo(() => extractNoteSections(baseNote), [baseNote]);

  useEffect(() => {
    if (
      lifecycle.phase === "idle" &&
      lifecycle.submittedVia === "text" &&
      lifecycle.submittedInput
    ) {
      setText(lifecycle.submittedInput);
    }
  }, [lifecycle.phase, lifecycle.submittedInput, lifecycle.submittedVia]);

  useEffect(() => {
    if (!visible) {
      setExpandedId(null);
    }
  }, [visible]);

  const hasConflict = recorder.clip !== null && text.trim().length > 0;

  const runInstruction = (instruction: string) => {
    void lifecycle.submit({
      encounterId,
      textInstruction: instruction,
      audio: null,
      version: currentVersion,
      providerId,
      baseNote,
    });
  };

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed && !recorder.clip) {
      Alert.alert(
        "Empty instruction",
        "Pick a quick edit or describe what you'd like to change.",
      );
      return;
    }
    void lifecycle.submit({
      encounterId,
      textInstruction: trimmed,
      audio: recorder.clip,
      version: currentVersion,
      providerId,
      baseNote,
    });
  };

  const toggleAccordion = (id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  const renderAccordionOptions = (accordion: QuickEditAccordion) => {
    if (accordion.options) {
      return accordion.options.map((opt) => (
        <Pressable
          key={opt.id}
          style={styles.optionChip}
          onPress={() => runInstruction(opt.instruction)}
        >
          <Text style={styles.optionChipText}>{opt.label}</Text>
        </Pressable>
      ));
    }

    if (accordion.useNoteSections && accordion.sectionInstruction) {
      return noteSections.map((section) => (
        <Pressable
          key={`${accordion.id}-${section}`}
          style={styles.optionChip}
          onPress={() =>
            runInstruction(accordion.sectionInstruction!(section))
          }
        >
          <Text style={styles.optionChipText}>{section}</Text>
        </Pressable>
      ));
    }

    return null;
  };

  const panelWidth = isTablet ? Math.min(420, width * 0.42) : width;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <Pressable style={styles.backdrop} onPress={onClose} />

        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={[
            styles.panelWrap,
            isTablet ? styles.panelWrapTablet : styles.panelWrapPhone,
          ]}
        >
          <View style={[styles.panel, { width: panelWidth }]}>
            {/* Header */}
            <View style={styles.header}>
              <Ionicons name="sparkles" size={18} color={colors.textInverse} />
              <Text style={styles.headerTitle}>Smart Edits</Text>
              <View style={{ flex: 1 }} />
              <Pressable onPress={onClose} hitSlop={8} style={styles.closeBtn}>
                <Text style={styles.closeBtnText}>Close panel</Text>
                <Ionicons
                  name="chevron-forward"
                  size={16}
                  color={colors.textInverse}
                />
              </Pressable>
            </View>

            {lifecycle.phase === "loading" ? (
              <View style={styles.loadingBlock}>
                <ActivityIndicator color={colors.brand} size="large" />
                <Text style={styles.loadingTitle}>
                  Processing{" "}
                  {lifecycle.submittedVia === "voice"
                    ? "voice recording"
                    : "your instruction"}
                  …
                </Text>
                <Text style={styles.loadingSub}>
                  {lifecycle.elapsedSeconds}s elapsed
                  {lifecycle.elapsedSeconds >= 30
                    ? " — AI processing may take 2–3 minutes"
                    : ""}
                </Text>
                <Pressable onPress={lifecycle.cancel} style={styles.cancelBtn}>
                  <Text style={styles.cancelBtnText}>Cancel</Text>
                </Pressable>
              </View>
            ) : (
              <ScrollView
                style={styles.scroll}
                contentContainerStyle={styles.scrollContent}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
              >
                <Text style={styles.introTitle}>
                  How would you like to update this note?
                </Text>
                <Text style={styles.introSub}>
                  Pick a quick edit below or type your own request. Review the
                  changes before they're saved.
                </Text>

                {/* Quick Edits */}
                <View style={styles.sectionLabelRow}>
                  <Ionicons name="flash" size={14} color={colors.warning} />
                  <Text style={styles.sectionLabel}>QUICK EDITS</Text>
                </View>

                <View style={styles.quickRow}>
                  {QUICK_EDIT_ACTIONS.map((action) => (
                    <Pressable
                      key={action.id}
                      style={styles.quickTile}
                      onPress={() => runInstruction(action.instruction)}
                    >
                      <Ionicons
                        name={action.icon as keyof typeof Ionicons.glyphMap}
                        size={18}
                        color={colors.brand}
                      />
                      <Text style={styles.quickTileText}>{action.label}</Text>
                    </Pressable>
                  ))}
                </View>

                {QUICK_EDIT_ACCORDIONS.map((accordion) => {
                  const open = expandedId === accordion.id;
                  return (
                    <View key={accordion.id} style={styles.accordion}>
                      <Pressable
                        style={[
                          styles.accordionHeader,
                          open && styles.accordionHeaderOpen,
                        ]}
                        onPress={() => toggleAccordion(accordion.id)}
                      >
                        <Ionicons
                          name={
                            accordion.icon as keyof typeof Ionicons.glyphMap
                          }
                          size={16}
                          color={open ? colors.textInverse : colors.text}
                        />
                        <Text
                          style={[
                            styles.accordionTitle,
                            open && styles.accordionTitleOpen,
                          ]}
                        >
                          {accordion.label}
                        </Text>
                        <Ionicons
                          name={open ? "chevron-up" : "chevron-down"}
                          size={16}
                          color={open ? colors.textInverse : colors.textSecondary}
                        />
                      </Pressable>
                      {open ? (
                        <View style={styles.accordionBody}>
                          {renderAccordionOptions(accordion)}
                        </View>
                      ) : null}
                    </View>
                  );
                })}

                {/* Custom request */}
                <View style={[styles.sectionLabelRow, { marginTop: spacing.lg }]}>
                  <Ionicons
                    name="chatbubble-ellipses-outline"
                    size={14}
                    color={colors.textSecondary}
                  />
                  <Text style={styles.sectionLabel}>OR ASK FOR SOMETHING ELSE</Text>
                </View>

                {hasConflict ? (
                  <View style={styles.conflictBanner}>
                    <Ionicons name="warning-outline" size={14} color="#9A6700" />
                    <Text style={styles.conflictText}>
                      Voice will be used. Text will be ignored.
                    </Text>
                    <Pressable onPress={() => void recorder.reset()} hitSlop={8}>
                      <Text style={styles.conflictAction}>Use text instead</Text>
                    </Pressable>
                  </View>
                ) : null}

                <View style={styles.askBox}>
                  <TextInput
                    value={text}
                    onChangeText={setText}
                    placeholder="Tell Scribe what to change. e.g. 'Shorten the assessment' or 'Add a follow-up in 2 weeks.'"
                    placeholderTextColor={colors.textTertiary}
                    style={styles.askInput}
                    multiline
                    textAlignVertical="top"
                  />
                  <View style={styles.askFooter}>
                    <MicButton recorder={recorder} />
                    {lifecycle.phase === "error" ? (
                      <Pressable style={styles.sendBtn} onPress={lifecycle.retry}>
                        <Ionicons name="refresh" size={16} color={colors.textInverse} />
                        <Text style={styles.sendBtnText}>Retry</Text>
                      </Pressable>
                    ) : (
                      <Pressable style={styles.sendBtn} onPress={handleSend}>
                        <Ionicons name="send" size={16} color={colors.textInverse} />
                        <Text style={styles.sendBtnText}>Send</Text>
                      </Pressable>
                    )}
                  </View>
                </View>

                {recorder.state === "stopped" && recorder.clip ? (
                  <PlaybackRow recorder={recorder} />
                ) : null}

                {(recorder.error || lifecycle.errorMessage) && lifecycle.phase === "error" ? (
                  <View style={styles.errorRow}>
                    <Ionicons name="alert-circle" size={14} color={colors.error} />
                    <Text style={styles.errorText}>
                      {recorder.error || lifecycle.errorMessage}
                    </Text>
                  </View>
                ) : null}

                <View style={styles.tipRow}>
                  <Ionicons name="bulb-outline" size={14} color={colors.textSecondary} />
                  <Text style={styles.tipText}>
                    Tip: Quick Edits are the fastest way to make common changes
                  </Text>
                </View>
              </ScrollView>
            )}
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

function MicButton({ recorder }: { recorder: AmendVoiceRecorder }) {
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (recorder.state !== "recording") {
      pulse.stopAnimation();
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 750,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 750,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, recorder.state]);

  const pulseScale = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.08],
  });

  if (recorder.state === "recording") {
    return (
      <Animated.View style={{ transform: [{ scale: pulseScale }] }}>
        <Pressable
          style={[styles.micBtn, styles.micBtnRecording]}
          onPress={() => void recorder.stop()}
        >
          <Ionicons name="stop" size={18} color={colors.textInverse} />
        </Pressable>
      </Animated.View>
    );
  }

  return (
    <Pressable
      style={styles.micBtn}
      onPress={() => void recorder.start()}
    >
      <Ionicons name="mic-outline" size={20} color={colors.textSecondary} />
    </Pressable>
  );
}

function PlaybackRow({ recorder }: { recorder: AmendVoiceRecorder }) {
  const clip = recorder.clip;
  if (!clip) return null;

  const totalSeconds = Math.max(1, clip.durationSeconds);
  const positionSeconds = Math.min(recorder.playbackPosition, totalSeconds);
  const progress = Math.min(1, positionSeconds / totalSeconds);

  return (
    <View style={styles.playbackRow}>
      <Pressable
        style={styles.playbackBtn}
        onPress={() => void recorder.togglePlayback()}
      >
        <Ionicons
          name={recorder.playbackState === "playing" ? "pause" : "play"}
          size={14}
          color={colors.textInverse}
        />
      </Pressable>
      <View style={styles.playbackTrackWrap}>
        <View style={styles.playbackTrack}>
          <View
            style={[styles.playbackFill, { width: `${progress * 100}%` }]}
          />
        </View>
        <Text style={styles.playbackTime}>
          {formatDuration(positionSeconds)} / {formatDuration(totalSeconds)}
        </Text>
      </View>
      <Pressable onPress={() => void recorder.reset()}>
        <Ionicons name="close-circle" size={20} color={colors.textSecondary} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    flexDirection: "row",
  },
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  panelWrap: {
    maxHeight: "100%",
  },
  panelWrapTablet: {
    alignSelf: "stretch",
    justifyContent: "flex-end",
  },
  panelWrapPhone: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: "92%",
  },
  panel: {
    flex: 1,
    backgroundColor: colors.card,
    borderLeftWidth: 1,
    borderLeftColor: colors.border,
    shadowColor: "#000",
    shadowOffset: { width: -2, height: 0 },
    shadowOpacity: 0.12,
    shadowRadius: 8,
    elevation: 8,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.brand,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    gap: spacing.xs,
  },
  headerTitle: {
    color: colors.textInverse,
    fontSize: fontSize.md,
    fontWeight: "700",
  },
  closeBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  closeBtnText: {
    color: colors.textInverse,
    fontSize: 12,
    fontWeight: "500",
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: spacing.lg,
    paddingBottom: spacing.xxxl,
  },
  introTitle: {
    fontSize: fontSize.lg,
    fontWeight: "700",
    color: colors.text,
    marginBottom: spacing.xs,
  },
  introSub: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    lineHeight: 20,
    marginBottom: spacing.lg,
  },
  sectionLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: spacing.sm,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: colors.textSecondary,
    letterSpacing: 0.6,
  },
  quickRow: {
    flexDirection: "row",
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  quickTile: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.bg,
  },
  quickTileText: {
    fontSize: fontSize.sm,
    fontWeight: "600",
    color: colors.text,
  },
  accordion: {
    marginBottom: spacing.xs,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    overflow: "hidden",
  },
  accordionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    backgroundColor: colors.bg,
  },
  accordionHeaderOpen: {
    backgroundColor: colors.brand,
  },
  accordionTitle: {
    flex: 1,
    fontSize: fontSize.sm,
    fontWeight: "600",
    color: colors.text,
  },
  accordionTitleOpen: {
    color: colors.textInverse,
  },
  accordionBody: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    padding: spacing.md,
    backgroundColor: colors.card,
  },
  optionChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  optionChipText: {
    fontSize: fontSize.sm,
    color: colors.text,
    fontWeight: "500",
  },
  askBox: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.bg,
    overflow: "hidden",
  },
  askInput: {
    minHeight: 100,
    padding: spacing.md,
    fontSize: fontSize.sm,
    color: colors.text,
  },
  askFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
  },
  micBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  micBtnRecording: {
    backgroundColor: colors.error,
  },
  sendBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.brand,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
  },
  sendBtnText: {
    color: colors.textInverse,
    fontSize: fontSize.sm,
    fontWeight: "700",
  },
  conflictBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    backgroundColor: "#FFF8E1",
    padding: spacing.sm,
    borderRadius: radius.sm,
    marginBottom: spacing.sm,
  },
  conflictText: {
    flex: 1,
    color: "#9A6700",
    fontSize: 12,
  },
  conflictAction: {
    color: "#9A6700",
    fontSize: 12,
    fontWeight: "600",
  },
  playbackRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  playbackBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.success,
    alignItems: "center",
    justifyContent: "center",
  },
  playbackTrackWrap: {
    flex: 1,
    gap: 4,
  },
  playbackTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.borderLight,
    overflow: "hidden",
  },
  playbackFill: {
    height: "100%",
    backgroundColor: colors.success,
  },
  playbackTime: {
    fontSize: 11,
    color: colors.textSecondary,
  },
  tipRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    marginTop: spacing.lg,
    padding: spacing.md,
    backgroundColor: colors.borderLight,
    borderRadius: radius.md,
  },
  tipText: {
    flex: 1,
    fontSize: 12,
    color: colors.textSecondary,
    lineHeight: 18,
  },
  loadingBlock: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xxxl,
    gap: spacing.md,
  },
  loadingTitle: {
    fontSize: fontSize.md,
    fontWeight: "600",
    color: colors.text,
    textAlign: "center",
  },
  loadingSub: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    textAlign: "center",
  },
  cancelBtn: {
    marginTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  cancelBtnText: {
    color: colors.error,
    fontSize: fontSize.sm,
    fontWeight: "600",
  },
  errorRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: spacing.sm,
  },
  errorText: {
    flex: 1,
    color: colors.error,
    fontSize: 12,
  },
});
