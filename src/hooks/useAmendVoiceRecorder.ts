/**
 * Voice instruction recorder for Smart Edit.
 *
 * Thin wrapper around `expo-av` `Audio.Recording` that mirrors the surface of
 * the web's `useVoiceRecorder.js` composable. Records AAC inside an `.m4a`
 * container — the AI Scribe `/encounters/{id}/amend/voice` endpoint accepts
 * any format WhisperX understands, and AAC keeps file sizes small enough that
 * a typical 30 s instruction is well under 1 MB.
 *
 * Constraints:
 *   - 5 minute hard cap (same as web). Auto-stops when reached.
 *   - Releases the iOS audio session on stop and on unmount so we don't
 *     conflict with the main RecordScreen when the user navigates back.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Audio } from "expo-av";
import type { AVPlaybackStatus } from "expo-av";

export type RecorderState = "idle" | "recording" | "stopped" | "error";
export type PlaybackState = "idle" | "playing" | "paused";

export interface RecordedClip {
  uri: string;
  name: string;
  mimeType: string;
  durationSeconds: number;
}

export interface AmendVoiceRecorder {
  state: RecorderState;
  isSupported: boolean;
  duration: number;
  clip: RecordedClip | null;
  error: string | null;

  start: () => Promise<void>;
  stop: () => Promise<RecordedClip | null>;
  reset: () => Promise<void>;

  // ── Playback of the last-recorded clip ────────────────────────────────
  playbackState: PlaybackState;
  /** Current playhead in seconds (0…clip.durationSeconds). */
  playbackPosition: number;
  togglePlayback: () => Promise<void>;
}

const MAX_RECORDING_SECONDS = 5 * 60;

export function useAmendVoiceRecorder(): AmendVoiceRecorder {
  const [state, setState] = useState<RecorderState>("idle");
  const [duration, setDuration] = useState(0);
  const [clip, setClip] = useState<RecordedClip | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Playback state for the just-recorded clip. The Sound instance is held
  // in a ref so we can unload it cleanly across re-renders, reset, and
  // component unmount without leaking native resources.
  const [playbackState, setPlaybackState] = useState<PlaybackState>("idle");
  const [playbackPosition, setPlaybackPosition] = useState(0);
  const soundRef = useRef<Audio.Sound | null>(null);

  const recordingRef = useRef<Audio.Recording | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const unloadSound = useCallback(async () => {
    const snd = soundRef.current;
    soundRef.current = null;
    setPlaybackState("idle");
    setPlaybackPosition(0);
    if (snd) {
      try {
        await snd.unloadAsync();
      } catch {
        // ignore — instance may already be unloaded
      }
    }
  }, []);

  const onPlaybackStatusUpdate = useCallback(
    (status: AVPlaybackStatus) => {
      if (!status.isLoaded) {
        if ("error" in status && status.error) {
          // Treat any unloaded-with-error as a reset so the UI doesn't get
          // stuck in "playing" forever.
          void unloadSound();
        }
        return;
      }
      setPlaybackPosition(Math.floor((status.positionMillis ?? 0) / 1000));
      if (status.didJustFinish && !status.isLooping) {
        // Rewind to the start and pause so the user can tap play again.
        void (async () => {
          const snd = soundRef.current;
          if (!snd) return;
          try {
            await snd.setPositionAsync(0);
            await snd.pauseAsync();
          } catch {
            // ignore
          }
          setPlaybackState("paused");
          setPlaybackPosition(0);
        })();
      } else if (status.isPlaying) {
        setPlaybackState("playing");
      } else {
        setPlaybackState("paused");
      }
    },
    [unloadSound],
  );

  const clearTick = useCallback(() => {
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }, []);

  const releaseAudioSession = useCallback(async () => {
    try {
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
    } catch {
      // Non-fatal; the session may already be released.
    }
  }, []);

  const finalize = useCallback(async (): Promise<RecordedClip | null> => {
    const rec = recordingRef.current;
    if (!rec) return null;
    recordingRef.current = null;
    clearTick();

    let uri: string | null = null;
    try {
      await rec.stopAndUnloadAsync();
    } catch {
      // If stopping fails we still attempt to read the URI below.
    }
    try {
      uri = rec.getURI();
    } catch {
      uri = null;
    }
    await releaseAudioSession();

    if (!uri) return null;
    const result: RecordedClip = {
      uri,
      name: "smart_edit_instruction.m4a",
      mimeType: "audio/m4a",
      durationSeconds: duration,
    };
    setClip(result);
    setState("stopped");
    return result;
  }, [clearTick, duration, releaseAudioSession]);

  const start = useCallback(async () => {
    setError(null);
    // If a previous clip is loaded for playback, free it before we open the
    // mic — iOS only allows one audio session at a time.
    await unloadSound();
    try {
      const perm = await Audio.requestPermissionsAsync();
      if (!perm.granted) {
        setError("Microphone access is needed to dictate Smart Edit instructions.");
        setState("error");
        return;
      }
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });
      const { recording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY,
      );
      recordingRef.current = recording;
      setClip(null);
      setDuration(0);
      setState("recording");

      clearTick();
      tickRef.current = setInterval(() => {
        setDuration((d) => {
          const next = d + 1;
          if (next >= MAX_RECORDING_SECONDS) {
            // Hit the cap — stop in the next tick so React state is consistent.
            void finalize();
          }
          return next;
        });
      }, 1000);
    } catch (err) {
      const message =
        (err instanceof Error && err.message) ||
        "Could not start recording. Please try again.";
      setError(message);
      setState("error");
      recordingRef.current = null;
      clearTick();
      await releaseAudioSession();
    }
  }, [clearTick, finalize, releaseAudioSession, unloadSound]);

  const stop = useCallback(async () => {
    if (state !== "recording") return clip;
    return finalize();
  }, [clip, finalize, state]);

  const reset = useCallback(async () => {
    clearTick();
    await unloadSound();
    const rec = recordingRef.current;
    recordingRef.current = null;
    if (rec) {
      try {
        await rec.stopAndUnloadAsync();
      } catch {
        // ignore
      }
    }
    await releaseAudioSession();
    setState("idle");
    setDuration(0);
    setClip(null);
    setError(null);
  }, [clearTick, releaseAudioSession, unloadSound]);

  const togglePlayback = useCallback(async () => {
    const current = clip;
    if (!current) return;

    // Lazy-load the Sound the first time the user taps play.
    if (!soundRef.current) {
      try {
        // Make sure playback works even when the iPhone's silent switch
        // is on — providers test this often with the phone muted.
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: false,
          playsInSilentModeIOS: true,
        });
        const { sound } = await Audio.Sound.createAsync(
          { uri: current.uri },
          { shouldPlay: true, progressUpdateIntervalMillis: 250 },
          onPlaybackStatusUpdate,
        );
        soundRef.current = sound;
        setPlaybackState("playing");
      } catch {
        // Surface but don't lose the recording — user can still submit it.
        setError("Couldn't play back the recording. You can still send it.");
      }
      return;
    }

    try {
      const status = await soundRef.current.getStatusAsync();
      if (!status.isLoaded) return;
      if (status.isPlaying) {
        await soundRef.current.pauseAsync();
        setPlaybackState("paused");
      } else {
        // If we previously hit the end, replay from the start.
        if (
          status.durationMillis != null &&
          status.positionMillis >= status.durationMillis - 50
        ) {
          await soundRef.current.setPositionAsync(0);
        }
        await soundRef.current.playAsync();
        setPlaybackState("playing");
      }
    } catch {
      // ignore — UI will fall back to the latest status update
    }
  }, [clip, onPlaybackStatusUpdate]);

  useEffect(() => {
    return () => {
      clearTick();
      const rec = recordingRef.current;
      recordingRef.current = null;
      if (rec) {
        void rec.stopAndUnloadAsync().catch(() => {});
      }
      const snd = soundRef.current;
      soundRef.current = null;
      if (snd) {
        void snd.unloadAsync().catch(() => {});
      }
      void Audio.setAudioModeAsync({ allowsRecordingIOS: false }).catch(() => {});
    };
  }, [clearTick]);

  return {
    state,
    isSupported: true,
    duration,
    clip,
    error,
    start,
    stop,
    reset,
    playbackState,
    playbackPosition,
    togglePlayback,
  };
}
