/**
 * Bottom sticky input bar for Smart Edit. Hosts:
 *
 *   - Mic button (idle / recording / stopped) wired to the voice recorder.
 *   - Text field for typed instructions.
 *   - Submit button. When the lifecycle is in `error` we swap to Retry.
 *   - Loading state with elapsed-seconds counter + cancel.
 *
 * The component is presentational: all state lives in the parent-supplied
 * `lifecycle` and `recorder` objects so the dialog (`SmartEditDiffSheet`)
 * and this bar can react to the same state.
 */
import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { colors, fontSize, radius, spacing } from "../lib/theme";
import type { AmendLifecycle } from "../hooks/useAmendLifecycle";
import type { AmendVoiceRecorder } from "../hooks/useAmendVoiceRecorder";

interface Props {
  lifecycle: AmendLifecycle;
  recorder: AmendVoiceRecorder;
  encounterId: string;
  currentVersion: string | null;
  providerId?: string | null;
  baseNote: string | null;
  onClose: () => void;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function SmartEditInput({
  lifecycle,
  recorder,
  encounterId,
  currentVersion,
  providerId,
  baseNote,
  onClose,
}: Props) {
  const [text, setText] = useState("");

  // Pre-fill the text field when the lifecycle returns to idle with a previous
  // submission still tracked (revise flow). Only do this for text submissions —
  // voice ones would dump "Voice recording" into the textbox.
  useEffect(() => {
    if (
      lifecycle.phase === "idle" &&
      lifecycle.submittedVia === "text" &&
      lifecycle.submittedInput
    ) {
      setText(lifecycle.submittedInput);
    }
  }, [lifecycle.phase, lifecycle.submittedInput, lifecycle.submittedVia]);

  const hasConflict =
    recorder.clip !== null && text.trim().length > 0;

  const handleSubmit = () => {
    const trimmed = text.trim();
    if (!trimmed && !recorder.clip) {
      Alert.alert(
        "Empty instruction",
        "Please type a change or record a voice instruction first.",
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

  // ── Loading state ────────────────────────────────────────────────────────
  if (lifecycle.phase === "loading") {
    return (
      <View style={styles.wrapper}>
        <View style={styles.header}>
          <Ionicons name="sparkles-outline" size={16} color={colors.textInverse} />
          <Text style={styles.headerTitle}>Smart Edit</Text>
        </View>
        <View style={styles.loadingRow}>
          <ActivityIndicator color={colors.brand} />
          <View style={{ flex: 1, marginLeft: spacing.md }}>
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
          </View>
          <Pressable onPress={lifecycle.cancel} hitSlop={8}>
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // ── Default input state (also covers `error` — we just show the retry CTA) ─
  return (
    <View style={styles.wrapper}>
      <View style={styles.header}>
        <Ionicons name="sparkles-outline" size={16} color={colors.textInverse} />
        <Text style={styles.headerTitle}>Smart Edit</Text>
        <View style={{ flex: 1 }} />
        <Pressable onPress={onClose} hitSlop={8}>
          <Ionicons name="close" size={18} color={colors.textInverse} />
        </Pressable>
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

      {lifecycle.phase === "idle" &&
      lifecycle.submittedVia === "voice" &&
      lifecycle.submittedInput ? (
        <View style={styles.reviseHint}>
          <Text style={styles.reviseHintText}>
            Previous submission was voice. Type text to revise.
          </Text>
        </View>
      ) : null}

      <View style={styles.inputRow}>
        <MicButton recorder={recorder} />

        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="Describe changes to apply to this note…"
          placeholderTextColor={colors.textTertiary}
          style={styles.textInput}
          multiline
        />

        {lifecycle.phase === "error" ? (
          <Pressable
            style={styles.retryButton}
            onPress={lifecycle.retry}
            hitSlop={8}
          >
            <Ionicons name="refresh" size={16} color={colors.textInverse} />
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        ) : (
          <Pressable
            style={styles.sendButton}
            onPress={handleSubmit}
            hitSlop={8}
          >
            <Ionicons name="send" size={18} color={colors.textInverse} />
          </Pressable>
        )}
      </View>

      {recorder.state === "stopped" && recorder.clip ? (
        <PlaybackRow recorder={recorder} />
      ) : null}

      {recorder.error ? (
        <View style={styles.errorRow}>
          <Ionicons name="alert-circle-outline" size={14} color={colors.error} />
          <Text style={styles.errorText}>{recorder.error}</Text>
        </View>
      ) : null}

      {lifecycle.phase === "error" && lifecycle.errorMessage ? (
        <View style={styles.errorRow}>
          <Ionicons name="alert-circle" size={14} color={colors.error} />
          <Text style={styles.errorText}>{lifecycle.errorMessage}</Text>
        </View>
      ) : null}
    </View>
  );
}

interface MicButtonProps {
  recorder: AmendVoiceRecorder;
}

function MicButton({ recorder }: MicButtonProps) {
  // Continuous pulse on the red record button so the active recording is
  // visually unmissable, even at a glance. Mirrors the CSS `pulse-ring`
  // keyframe on the web (`InlineAmendInput.vue`).
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
    return () => {
      loop.stop();
    };
  }, [pulse, recorder.state]);

  const pulseScale = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.08],
  });

  if (recorder.state === "recording") {
    return (
      <View style={{ alignItems: "center" }}>
        <Animated.View style={{ transform: [{ scale: pulseScale }] }}>
          <Pressable
            style={[styles.micButton, styles.micButtonRecording]}
            onPress={() => void recorder.stop()}
            hitSlop={6}
          >
            <Ionicons name="stop" size={18} color={colors.textInverse} />
          </Pressable>
        </Animated.View>
        <Text style={styles.micDuration}>
          {formatDuration(recorder.duration)}
        </Text>
      </View>
    );
  }
  if (recorder.state === "stopped") {
    return (
      <Pressable
        style={[styles.micButton, styles.micButtonStopped]}
        onPress={() => void recorder.reset()}
        hitSlop={6}
      >
        <Ionicons name="mic" size={18} color={colors.success} />
      </Pressable>
    );
  }
  return (
    <Pressable
      style={[styles.micButton, styles.micButtonIdle]}
      onPress={() => void recorder.start()}
      hitSlop={6}
    >
      <Ionicons name="mic" size={18} color={colors.textInverse} />
    </Pressable>
  );
}

interface PlaybackRowProps {
  recorder: AmendVoiceRecorder;
}

/** Playback bar shown under the input row once a clip is recorded. The
 *  provider can preview the audio before submitting, mirroring the
 *  <audio controls> element on the web. */
function PlaybackRow({ recorder }: PlaybackRowProps) {
  const clip = recorder.clip;
  if (!clip) return null;

  const totalSeconds = Math.max(1, clip.durationSeconds);
  const positionSeconds = Math.min(recorder.playbackPosition, totalSeconds);
  const progress = Math.min(1, positionSeconds / totalSeconds);
  const isPlaying = recorder.playbackState === "playing";

  return (
    <View style={styles.playbackRow}>
      <Pressable
        style={styles.playbackButton}
        onPress={() => void recorder.togglePlayback()}
        hitSlop={6}
      >
        <Ionicons
          name={isPlaying ? "pause" : "play"}
          size={16}
          color={colors.textInverse}
        />
      </Pressable>

      <View style={styles.playbackTrackWrap}>
        <View style={styles.playbackTrack}>
          <View
            style={[
              styles.playbackTrackFill,
              { width: `${progress * 100}%` },
            ]}
          />
        </View>
        <Text style={styles.playbackTime}>
          {formatDuration(positionSeconds)} / {formatDuration(totalSeconds)}
        </Text>
      </View>

      <Pressable
        onPress={() => void recorder.reset()}
        hitSlop={6}
        accessibilityLabel="Discard recording"
      >
        <Ionicons name="close-circle" size={20} color={colors.textSecondary} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    backgroundColor: colors.card,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    borderRadius: radius.lg,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.06,
    shadowRadius: 6,
    elevation: 3,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.brand,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.xs,
  },
  headerTitle: {
    color: colors.textInverse,
    fontSize: fontSize.sm,
    fontWeight: "600",
  },
  conflictBanner: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#FFF8E1",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    gap: spacing.xs,
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
  reviseHint: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    backgroundColor: "#FFF8E1",
  },
  reviseHintText: {
    color: "#9A6700",
    fontSize: 12,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  textInput: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    fontSize: fontSize.sm,
    color: colors.text,
    backgroundColor: colors.bg,
  },
  micButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  micButtonIdle: {
    backgroundColor: colors.brand,
  },
  micButtonRecording: {
    backgroundColor: colors.error,
  },
  micButtonStopped: {
    backgroundColor: colors.card,
    borderWidth: 1.5,
    borderColor: colors.success,
  },
  micDuration: {
    marginTop: 2,
    fontSize: 11,
    color: colors.error,
    fontVariant: ["tabular-nums"],
  },
  sendButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.brand,
    alignItems: "center",
    justifyContent: "center",
  },
  retryButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    backgroundColor: colors.brand,
    borderRadius: radius.sm,
  },
  retryText: {
    color: colors.textInverse,
    fontSize: fontSize.sm,
    fontWeight: "600",
  },
  playbackRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
  },
  playbackButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
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
  playbackTrackFill: {
    height: "100%",
    backgroundColor: colors.success,
    borderRadius: 2,
  },
  playbackTime: {
    fontSize: 11,
    color: colors.textSecondary,
    fontVariant: ["tabular-nums"],
  },
  loadingRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  loadingTitle: {
    fontSize: fontSize.sm,
    color: colors.text,
    fontWeight: "500",
  },
  loadingSub: {
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: 2,
  },
  cancelText: {
    color: colors.error,
    fontSize: fontSize.sm,
    fontWeight: "600",
  },
  errorRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
  },
  errorText: {
    flex: 1,
    color: colors.error,
    fontSize: 12,
  },
});
