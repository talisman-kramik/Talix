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
  Keyboard,
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
import { useSafeAreaInsets } from "react-native-safe-area-context";
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
  const { width, height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const isTablet = width >= 768;
  const [text, setText] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const scrollRef = useRef<ScrollView>(null);
  const askInputRef = useRef<TextInput>(null);

  const noteSections = useMemo(() => extractNoteSections(baseNote), [baseNote]);

  // Lift the panel above the soft keyboard. KeyboardAvoidingView alone is
  // unreliable inside Modals on iOS, so we also track keyboard height.
  useEffect(() => {
    if (!visible) {
      setKeyboardHeight(0);
      return;
    }
    const showEvent =
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent =
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const showSub = Keyboard.addListener(showEvent, (e) => {
      setKeyboardHeight(e.endCoordinates.height);
    });
    const hideSub = Keyboard.addListener(hideEvent, () => {
      setKeyboardHeight(0);
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [visible]);

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

  // Surface API failures prominently — footer-only errors are easy to miss
  // after a quick edit tap.
  useEffect(() => {
    if (visible && lifecycle.phase === "error" && lifecycle.errorMessage) {
      Alert.alert("Smart Edit failed", lifecycle.errorMessage);
    }
  }, [visible, lifecycle.phase, lifecycle.errorMessage]);

  const hasConflict = recorder.clip !== null && text.trim().length > 0;

  const runInstruction = (instruction: string) => {
    Keyboard.dismiss();
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
    Keyboard.dismiss();
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
  // Explicit height is required — without it flex children collapse to header-only.
  const sheetHeight = isTablet
    ? Math.round(windowHeight - insets.top)
    : Math.round(windowHeight * 0.88);

  const scrollQuickEdits = () => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollToEnd({ animated: true });
    });
  };

  const customAskSection = (includeTip: boolean) => (
    <>
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
          ref={askInputRef}
          value={text}
          onChangeText={setText}
          placeholder="Tell Scribe what to change. e.g. 'Shorten the assessment' or 'Add a follow-up in 2 weeks.'"
          placeholderTextColor={colors.textTertiary}
          style={styles.askInput}
          multiline
          textAlignVertical="top"
          onFocus={scrollQuickEdits}
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

      {includeTip ? (
        <View style={styles.tipRow}>
          <Ionicons name="bulb-outline" size={14} color={colors.textSecondary} />
          <Text style={styles.tipText}>
            Tip: Quick Edits are the fastest way to make common changes
          </Text>
        </View>
      ) : null}
    </>
  );

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.overlay} pointerEvents="box-none">
        <Pressable style={styles.backdrop} onPress={onClose} />

        <View
          style={[
            styles.panel,
            isTablet ? styles.panelSide : styles.panelBottom,
            {
              width: panelWidth,
              height: sheetHeight,
              top: isTablet ? insets.top : undefined,
              bottom: !isTablet ? keyboardHeight : undefined,
              paddingBottom: isTablet ? 0 : insets.bottom,
            },
          ]}
        >
          {!isTablet ? <View style={styles.sheetHandle} /> : null}

          {/* Header */}
          <View style={styles.header}>
            <Ionicons name="sparkles" size={18} color={colors.textInverse} />
            <Text style={styles.headerTitle}>Smart Edits</Text>
            <View style={{ flex: 1 }} />
            <Pressable onPress={onClose} hitSlop={8} style={styles.closeBtn}>
              <Text style={styles.closeBtnText}>Close panel</Text>
              <Ionicons
                name={isTablet ? "chevron-forward" : "chevron-down"}
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
            <View style={styles.body}>
              {lifecycle.phase === "error" && lifecycle.errorMessage ? (
                <View style={styles.errorBanner}>
                  <Ionicons name="alert-circle" size={16} color={colors.error} />
                  <Text style={styles.errorBannerText}>{lifecycle.errorMessage}</Text>
                </View>
              ) : null}

              <ScrollView
                ref={scrollRef}
                style={styles.scroll}
                contentContainerStyle={styles.scrollContent}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="interactive"
                showsVerticalScrollIndicator
              >
                  <Text style={styles.introTitle}>
                    How would you like to update this note?
                  </Text>
                  <Text style={styles.introSub}>
                    Pick a quick edit below or type your own request. Review the
                    changes before they're saved.
                  </Text>

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
                            color={
                              open ? colors.textInverse : colors.textSecondary
                            }
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

                  {/* On tablet keep custom ask in scroll; on phone pin above keyboard */}
                  {isTablet ? customAskSection(true) : (
                    <View style={styles.tipRow}>
                      <Ionicons name="bulb-outline" size={14} color={colors.textSecondary} />
                      <Text style={styles.tipText}>
                        Tip: Quick Edits are the fastest way to make common changes
                      </Text>
                    </View>
                  )}
                </ScrollView>

                {!isTablet ? (
                  <View style={styles.inputFooter}>{customAskSection(false)}</View>
                ) : null}
              </View>
            )}
        </View>
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
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 1,
  },
  panel: {
    zIndex: 2,
    flexDirection: "column",
    backgroundColor: colors.card,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.15,
    shadowRadius: 10,
    elevation: 12,
  },
  panelBottom: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
  },
  panelSide: {
    position: "absolute",
    right: 0,
    top: 0,
    bottom: 0,
    borderLeftWidth: 1,
    borderLeftColor: colors.border,
  },
  sheetHandle: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
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
  body: {
    flex: 1,
    minHeight: 0,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: spacing.lg,
    paddingBottom: spacing.md,
  },
  inputFooter: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.card,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.lg,
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
    minHeight: 72,
    maxHeight: 120,
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
    marginTop: spacing.md,
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
  errorBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
    padding: spacing.sm,
    backgroundColor: "#FEF2F2",
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: "#FECACA",
  },
  errorBannerText: {
    flex: 1,
    color: colors.error,
    fontSize: fontSize.sm,
    lineHeight: 18,
  },
  errorText: {
    flex: 1,
    color: colors.error,
    fontSize: 12,
  },
});
