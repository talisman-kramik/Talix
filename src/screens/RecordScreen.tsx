/**
 * Record screen — audio capture with provider/patient/visit-type selection.
 * Mirrors the web Capture page. Supports offline queueing.
 */
import React, { useEffect, useState, useRef, useCallback, useMemo } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
  Platform,
  useWindowDimensions,
  FlatList,
  TextInput,
  ActivityIndicator,
  PanResponder,
  type LayoutChangeEvent,
} from "react-native";
import { Audio } from "expo-av";
import * as FileSystem from "expo-file-system/legacy";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import DateTimePicker, { DateTimePickerAndroid } from "@react-native-community/datetimepicker";
import * as DocumentPicker from "expo-document-picker";

import Card from "../components/Card";
import ProgressBar from "../components/ProgressBar";
import { colors, fontSize, spacing, radius } from "../lib/theme";
import {
  fetchPatientsByProviderDate,
  createEncounter,
  resolveEncounterProviderId,
  uploadEncounterAudio,
  buildEncounterDetailsFromPatient,
  formatEncounterDetailsDebugMessage,
  resolveClientEncounterId,
  fetchEncounterStatus,
  getWsUrl,
  resolveVisitType,
  formatPatientNameLastFirst,
  ECLIPSE_LOCATION_LABEL,
  type EclipseLocation,
  type PatientSearchResult,
} from "../lib/api";
import { useSettings, getApiKey, getApiUrl } from "../store/settings";
import { useOfflineStore } from "../store/offline";
import { useAuthStore } from "../store/auth";
import { useProviders } from "../store/providers";
import {
  getCachedPatients,
  setCachedPatients,
} from "../store/patientsCache";
import { findProviderForUser } from "../lib/providerMatch";
import { formatDateUS } from "../lib/date";

const MODES = [
  { value: "dictation", label: "Dictation" },
  { value: "ambient", label: "Conversation" },
];

type PipelineStage = "idle" | "recording" | "creating" | "uploading" | "processing" | "complete" | "error";

function normalize(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function getPatientDisplayName(patient: Pick<PatientSearchResult, "first_name" | "last_name" | "mrn" | "id">): string {
  // Display "Last, First" to match the web app's patient list.
  const first = String(patient.first_name || "").trim();
  const last = String(patient.last_name || "").trim();
  if (first && last) return `${last}, ${first}`;
  const single = last || first;
  if (single) return single;
  if (patient.mrn) return `MRN: ${patient.mrn}`;
  return patient.id;
}

function getTodayDateIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseIsoDate(value: string): Date {
  const [yearStr, monthStr, dayStr] = value.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  if (!year || !month || !day) return new Date();
  return new Date(year, month - 1, day);
}

function formatIsoDate(date: Date): string {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, "0");
  const d = `${date.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatDateForDisplay(isoDate: string): string {
  return formatDateUS(isoDate);
}

// ---------------------------------------------------------------------------
// US Eastern timezone helpers — used to auto-select today's current patient
// based on appointment time.
// ---------------------------------------------------------------------------

const ET_TIMEZONE = "America/New_York";

// How close (in minutes) an appointment must be to "now ET" before we auto-
// select it. Covers an ongoing visit running long and the next one starting
// soon, without jumping to unrelated morning/afternoon slots.
const APPOINTMENT_MATCH_WINDOW_MINUTES = 90;

function getEtDateIso(): string {
  // en-CA gives YYYY-MM-DD; the Intl polyfill on RN handles America/New_York.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ET_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function getEtMinutesNow(): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ET_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

function etMinutesFromUtcDate(d: Date): number | null {
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ET_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return hour * 60 + minute;
}

// Convert an Eclipse appointment timestamp to ET minutes-since-midnight.
// Handles both timezone-aware (ISO with Z or ±HH:MM) and naive strings,
// where naive values are assumed to already be wall-clock ET.
function appointmentTimeToEtMinutes(value: unknown): number | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  if (/Z$|[+-]\d{2}:?\d{2}$/.test(raw)) {
    return etMinutesFromUtcDate(new Date(raw));
  }

  const match = raw.match(/(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

// Pick the patient whose appointment is closest to `nowMinutes`, within the
// configured window. Returns null when no candidate qualifies.
function findClosestAppointment(
  patients: PatientSearchResult[],
  nowMinutes: number,
): PatientSearchResult | null {
  let best: PatientSearchResult | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;

  for (const p of patients) {
    const apptMinutes = appointmentTimeToEtMinutes(p.appointment_at);
    if (apptMinutes === null) continue;
    const delta = Math.abs(apptMinutes - nowMinutes);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = p;
    }
  }

  if (!best || bestDelta > APPOINTMENT_MATCH_WINDOW_MINUTES) return null;
  return best;
}

// Tokenize a person's name for fuzzy matching: lowercase, strip honorifics
// and credentials, drop punctuation, return word tokens.
// findProviderForUser / tokensFromName moved to ../lib/providerMatch so the
// background-prefetch logic in App.tsx can reuse the exact same matching
// behavior without dragging in any screen-level state.

/**
 * Loading-state placeholder rows for the provider + patient pickers. The
 * web version of this form arrives with both dropdowns pre-populated via
 * SSR; on mobile we can't do that, but a couple of muted skeleton rows
 * shaped like the real items make the wait feel much less broken than a
 * single bare spinner.
 */
function SkeletonRow({ width }: { width: number }) {
  return (
    <View style={skeletonStyles.row}>
      <View style={[skeletonStyles.bar, { width: `${width}%` }]} />
      <View style={[skeletonStyles.barSm, { width: `${Math.max(20, width - 30)}%` }]} />
    </View>
  );
}

function SkeletonList({ count }: { count: number }) {
  const widths = [85, 70, 78, 65, 80, 72];
  return (
    <View style={skeletonStyles.list}>
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonRow key={i} width={widths[i % widths.length]} />
      ))}
    </View>
  );
}

const skeletonStyles = StyleSheet.create({
  list: {
    marginTop: 8,
    gap: 8,
  },
  row: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: "rgba(0,0,0,0.02)",
    borderRadius: 8,
  },
  bar: {
    height: 10,
    backgroundColor: "rgba(0,0,0,0.08)",
    borderRadius: 4,
    marginBottom: 6,
  },
  barSm: {
    height: 8,
    backgroundColor: "rgba(0,0,0,0.05)",
    borderRadius: 4,
  },
});

function base64ToUint8Array(base64: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = String(base64 || "").replace(/=+$/, "");
  let buffer = 0;
  let bits = 0;
  const out: number[] = [];
  for (let i = 0; i < clean.length; i++) {
    const val = alphabet.indexOf(clean[i]);
    if (val < 0) continue;
    buffer = (buffer << 6) | val;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/**
 * Locate the end of a RIFF/WAV header by scanning for the ASCII "data" chunk
 * marker and returning the byte offset immediately after the 8-byte chunk
 * descriptor ("data" + 4-byte little-endian size). Returns -1 if the marker
 * isn't found within the provided bytes (caller should wait for more data).
 *
 * Why: iOS AVAudioRecorder does not always emit the textbook 44-byte WAV
 * header — depending on the configured options it can include additional
 * FACT / LIST / INFO / JUNK chunks (commonly 46, 60, 78+ bytes). Hard-coding
 * 44 means a few stale header bytes get sent as PCM samples on the very
 * first chunk, which the ASR engine treats as noise and never recovers
 * sentence alignment from.
 */
function findWavDataOffset(bytes: Uint8Array): number {
  const max = Math.min(bytes.byteLength - 8, 4096);
  for (let i = 12; i <= max; i++) {
    if (
      bytes[i] === 0x64 && // 'd'
      bytes[i + 1] === 0x61 && // 'a'
      bytes[i + 2] === 0x74 && // 't'
      bytes[i + 3] === 0x61 // 'a'
    ) {
      return i + 8; // skip "data" + 4-byte size field
    }
  }
  return -1;
}

// Reusable audio preview / playback card. Lets providers verify the recorded
// or uploaded audio before submitting (item #11 in the QA feedback) by
// providing play/pause controls, a progress indicator, and a clear
// per-file card layout so multiple audio files (main vs. notes) read as
// distinct items.
type AudioPreviewCardProps = {
  uri: string;
  filename: string;
  label?: string;
  // Optional discard handler — when supplied, a small × button is rendered
  // on the right edge of the card.
  onDiscard?: () => void;
};

const SKIP_MS = 10_000;

function AudioPreviewCard({ uri, filename, label, onDiscard }: AudioPreviewCardProps) {
  const soundRef = useRef<Audio.Sound | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [loading, setLoading] = useState(false);

  // Track width is measured via onLayout so we can convert a touch X coordinate
  // into a fractional playhead position. Kept in a ref so PanResponder closures
  // always see the latest value without re-creating the responder.
  const trackWidthRef = useRef(0);
  const durationMsRef = useRef(0);
  const wasPlayingBeforeScrubRef = useRef(false);
  const [isScrubbing, setIsScrubbing] = useState(false);
  // Mirrors `positionMs` while the user is actively dragging, so the UI
  // tracks the finger smoothly without waiting for the native status update.
  const [scrubMs, setScrubMs] = useState(0);

  useEffect(() => {
    durationMsRef.current = durationMs;
  }, [durationMs]);

  useEffect(() => {
    let cancelled = false;
    let local: Audio.Sound | null = null;

    async function load() {
      try {
        setLoading(true);
        const created = await Audio.Sound.createAsync(
          { uri },
          { shouldPlay: false, progressUpdateIntervalMillis: 100 },
        );
        if (cancelled) {
          await created.sound.unloadAsync();
          return;
        }
        local = created.sound;
        soundRef.current = created.sound;
        local.setOnPlaybackStatusUpdate((status) => {
          if (!status.isLoaded) return;
          setDurationMs(status.durationMillis ?? 0);
          setIsPlaying(status.isPlaying ?? false);
          if (!wasPlayingBeforeScrubRef.current && status.positionMillis != null) {
            // While the user drags, ignore native position updates so the
            // thumb stays under the finger instead of snapping back.
          }
          setPositionMs((prev) => {
            return wasPlayingBeforeScrubRef.current ? prev : status.positionMillis ?? prev;
          });
          if (status.didJustFinish) {
            local?.setPositionAsync(0).catch(() => {});
          }
        });
      } catch {
        // Source may be missing / unsupported — leave duration at 0 so the
        // play button stays disabled.
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
      if (local) {
        local.unloadAsync().catch(() => {});
      }
      soundRef.current = null;
      setIsPlaying(false);
      setPositionMs(0);
      setDurationMs(0);
    };
  }, [uri]);

  const togglePlay = async () => {
    const s = soundRef.current;
    if (!s) return;
    try {
      if (isPlaying) {
        await s.pauseAsync();
      } else {
        if (durationMs > 0 && positionMs >= durationMs - 50) {
          await s.setPositionAsync(0);
        }
        await s.playAsync();
      }
    } catch {
      // Ignore playback errors — UI state will recover via status updates.
    }
  };

  const seekTo = useCallback(async (targetMs: number) => {
    const s = soundRef.current;
    const dur = durationMsRef.current;
    if (!s || dur <= 0) return;
    const clamped = Math.max(0, Math.min(dur, targetMs));
    try {
      await s.setPositionAsync(clamped);
      setPositionMs(clamped);
    } catch {
      // ignore
    }
  }, []);

  const skipBy = (deltaMs: number) => {
    const dur = durationMsRef.current;
    if (dur <= 0) return;
    seekTo(positionMs + deltaMs);
  };

  const onTrackLayout = (e: LayoutChangeEvent) => {
    trackWidthRef.current = e.nativeEvent.layout.width;
  };

  // Convert a touch X (within the track) to a playhead position in ms.
  const xToMs = (x: number): number => {
    const w = trackWidthRef.current;
    const dur = durationMsRef.current;
    if (w <= 0 || dur <= 0) return 0;
    const ratio = Math.max(0, Math.min(1, x / w));
    return ratio * dur;
  };

  // PanResponder gives us both tap-to-seek and drag-to-scrub in one handler.
  // The thumb follows the finger live; we only commit a setPositionAsync()
  // on release so we don't spam the native audio engine.
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        wasPlayingBeforeScrubRef.current = isPlaying;
        // Pause during scrub so audio doesn't keep racing ahead of the thumb.
        if (isPlaying) {
          soundRef.current?.pauseAsync().catch(() => {});
        }
        setIsScrubbing(true);
        const ms = xToMs(e.nativeEvent.locationX);
        setScrubMs(ms);
        setPositionMs(ms);
      },
      onPanResponderMove: (e) => {
        const ms = xToMs(e.nativeEvent.locationX);
        setScrubMs(ms);
        setPositionMs(ms);
      },
      onPanResponderRelease: async (e) => {
        const ms = xToMs(e.nativeEvent.locationX);
        await seekTo(ms);
        setIsScrubbing(false);
        if (wasPlayingBeforeScrubRef.current) {
          soundRef.current?.playAsync().catch(() => {});
        }
        wasPlayingBeforeScrubRef.current = false;
      },
      onPanResponderTerminate: async () => {
        setIsScrubbing(false);
        if (wasPlayingBeforeScrubRef.current) {
          soundRef.current?.playAsync().catch(() => {});
        }
        wasPlayingBeforeScrubRef.current = false;
      },
    }),
  ).current;

  const fmt = (ms: number) => {
    const total = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(total / 60);
    const ss = (total % 60).toString().padStart(2, "0");
    return `${m}:${ss}`;
  };
  const shownMs = isScrubbing ? scrubMs : positionMs;
  const progress = durationMs > 0 ? Math.min(1, shownMs / durationMs) : 0;
  const playDisabled = loading || durationMs <= 0;
  const skipDisabled = playDisabled;

  return (
    <View style={styles.audioPreviewCard}>
      <View style={styles.audioPreviewHeader}>
        <View style={styles.audioPreviewIconWrap}>
          <Ionicons name="document-text" size={20} color={colors.brand} />
        </View>
        <View style={{ flex: 1 }}>
          {label ? (
            <Text style={styles.audioPreviewLabel}>{label}</Text>
          ) : null}
          <Text style={styles.audioPreviewFilename} numberOfLines={1}>
            {filename}
          </Text>
        </View>
        {onDiscard ? (
          <TouchableOpacity onPress={onDiscard} hitSlop={8}>
            <Ionicons name="close-circle" size={22} color={colors.textTertiary} />
          </TouchableOpacity>
        ) : null}
      </View>

      <View style={styles.audioPreviewControls}>
        <TouchableOpacity
          style={[styles.audioSkipBtn, skipDisabled && styles.audioSkipBtnDisabled]}
          onPress={() => skipBy(-SKIP_MS)}
          disabled={skipDisabled}
          activeOpacity={0.7}
          hitSlop={8}
          accessibilityLabel="Rewind 10 seconds"
        >
          <Ionicons name="play-back" size={16} color={colors.brand} />
          <Text style={styles.audioSkipLabel}>10</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.audioPlayBtn, playDisabled && styles.audioPlayBtnDisabled]}
          onPress={togglePlay}
          disabled={playDisabled}
          activeOpacity={0.7}
        >
          {loading ? (
            <ActivityIndicator size="small" color={colors.textInverse} />
          ) : (
            <Ionicons
              name={isPlaying ? "pause" : "play"}
              size={18}
              color={colors.textInverse}
            />
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.audioSkipBtn, skipDisabled && styles.audioSkipBtnDisabled]}
          onPress={() => skipBy(SKIP_MS)}
          disabled={skipDisabled}
          activeOpacity={0.7}
          hitSlop={8}
          accessibilityLabel="Forward 10 seconds"
        >
          <Ionicons name="play-forward" size={16} color={colors.brand} />
          <Text style={styles.audioSkipLabel}>10</Text>
        </TouchableOpacity>

        <View
          style={styles.audioProgressHit}
          onLayout={onTrackLayout}
          {...panResponder.panHandlers}
        >
          <View style={styles.audioProgressTrack}>
            <View
              style={[styles.audioProgressFill, { width: `${progress * 100}%` }]}
            />
          </View>
          <View
            style={[
              styles.audioProgressThumb,
              { left: `${progress * 100}%` },
              isScrubbing && styles.audioProgressThumbActive,
            ]}
            pointerEvents="none"
          />
        </View>
        <Text style={styles.audioPreviewTime}>
          {fmt(shownMs)} / {fmt(durationMs)}
        </Text>
      </View>
    </View>
  );
}

export default function RecordScreen() {
  const nav = useNavigation<any>();
  const { width } = useWindowDimensions();
  const isTablet = width >= 768;
  // Tab navigator's header is hidden for this screen (see App.tsx), so we
  // add the system safe-area top inset ourselves to keep the heading clear
  // of the status bar on devices with a notch / Dynamic Island.
  const insets = useSafeAreaInsets();

  // Data — providers come from the shared store (pre-warmed at login).
  const storeProviders = useProviders((s) => s.providers);
  const providersStoreLoadedAt = useProviders((s) => s.loadedAt);
  const providersStoreError = useProviders((s) => s.error);
  const loadProviders = useProviders((s) => s.loadProviders);
  const providers = useMemo(
    () =>
      [...storeProviders].sort((a, b) =>
        normalize(a.name ?? a.id).localeCompare(normalize(b.name ?? b.id)),
      ),
    [storeProviders],
  );
  const providersLoaded =
    providersStoreLoadedAt !== null || providers.length > 0 || !!providersStoreError;
  const providerLoadError = providersStoreError;

  const [patients, setPatients] = useState<PatientSearchResult[]>([]);
  // `allPatients` holds the unfiltered list for the current provider/date so
  // typing in the search box filters locally instead of re-hitting the API.
  const [allPatients, setAllPatients] = useState<PatientSearchResult[]>([]);
  const [patientQuery, setPatientQuery] = useState("");
  const [appointmentDate, setAppointmentDate] = useState(getTodayDateIso());
  const [providerQuery, setProviderQuery] = useState("");
  const [patientLoadError, setPatientLoadError] = useState<string | null>(null);
  const [patientsLoading, setPatientsLoading] = useState(false);

  // Selections
  const [providerId, setProviderId] = useState("");
  const [providerPickerOpen, setProviderPickerOpen] = useState(false);
  const [selectedPatient, setSelectedPatient] = useState<PatientSearchResult | null>(null);
  const [mode, setMode] = useState("ambient");

  // Recording
  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [recordingUri, setRecordingUri] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [audioFilename, setAudioFilename] = useState("recording.m4a");
  const [noteRecording, setNoteRecording] = useState<Audio.Recording | null>(null);
  const [noteDuration, setNoteDuration] = useState(0);
  const [noteAudioUri, setNoteAudioUri] = useState<string | null>(null);
  const [noteAudioFilename, setNoteAudioFilename] = useState("note_audio.m4a");
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const noteTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Live transcript stays compact (~3 lines tall) but the inner ScrollView
  // lets the user read the full transcript by scrolling.
  const transcriptScrollRef = useRef<ScrollView | null>(null);
  const [asrStreaming, setAsrStreaming] = useState(false);
  const [asrPartialText, setAsrPartialText] = useState("");
  const [asrFinalSegments, setAsrFinalSegments] = useState<string[]>([]);
  const [asrError, setAsrError] = useState<string | null>(null);
  const [asrStatus, setAsrStatus] = useState("");
  const asrWsRef = useRef<WebSocket | null>(null);
  const asrReadIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const asrReadOffsetRef = useRef(0);
  const asrChunksSentRef = useRef(0);
  const asrPcmHeaderSkippedRef = useRef(false);
  // Computed length of the WAV header on the first read. iOS AVAudioRecorder
  // does not always write a fixed 44-byte header (it can include FACT / LIST
  // / JUNK chunks), so we locate the "data" chunk dynamically and skip past
  // it. Falls back to 44 only if no "data" marker is found in the first
  // bytes we read.
  const asrPcmHeaderLenRef = useRef<number>(0);
  const liveAsrFormatRef = useRef<"pcm" | "none">("pcm");

  // Pipeline
  const [stage, setStage] = useState<PipelineStage>("idle");
  const [progress, setProgress] = useState(0);
  const [statusMsg, setStatusMsg] = useState("");
  const [resultSampleId, setResultSampleId] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  // Status-poll fallback: keeps the UI moving even when the WebSocket can't
  // deliver progress events (e.g. WAF/ALB silently drops the upgraded socket,
  // mobile network NAT closes the long-lived connection, etc.). Polls
  // /encounters/{id}/status every few seconds until the pipeline reports
  // complete / failed, or the safety cap is reached.
  const statusPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const statusPollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Offline
  const { isOnline, enqueue, checkConnectivity } = useOfflineStore();

  // Re-fetch when the API URL changes (e.g. user saves cloudflare tunnel URL)
  const apiUrl = useSettings((s) => s.apiUrl);

  // Selected Eclipse location (PA = "Eclipse", Baltimore = "Micro"). The store
  // persists this across launches, so a clinician who works out of Baltimore
  // stays in Baltimore mode without re-toggling every session.
  const eclipseLocation = useSettings((s) => s.eclipseLocation);
  const setEclipseLocation = useSettings((s) => s.setEclipseLocation);

  // Logged-in user, used to auto-select their matching provider entry.
  const authUser = useAuthStore((s) => s.user);
  const authUserName = authUser?.name ?? null;
  const authUserEmail = authUser?.email ?? null;

  // Ensure providers are loaded for the active location. The store's
  // loadProviders is idempotent — it short-circuits when a fresh result for
  // the same location is already in memory (pre-warmed at login). Switching
  // location triggers a refetch (which may hit the per-location cache).
  useEffect(() => {
    loadProviders(eclipseLocation).catch(() => {});
    // apiUrl is included so a backend swap (e.g. tunnel URL change) refetches.
  }, [loadProviders, apiUrl, eclipseLocation]);

  // When the user switches locations, clear any in-memory selections — the
  // previously selected provider/patient may not exist in the new location's
  // dataset. The auto-select effects below pick a sensible default for the
  // new list.
  const prevLocationRef = useRef<EclipseLocation>(eclipseLocation);
  useEffect(() => {
    if (prevLocationRef.current !== eclipseLocation) {
      prevLocationRef.current = eclipseLocation;
      setProviderId("");
      setSelectedPatient(null);
      setPatients([]);
      setAllPatients([]);
      setPatientQuery("");
      setProviderQuery("");
      setPatientLoadError(null);
    }
  }, [eclipseLocation]);

  // Auto-select the logged-in user as provider once the list is available.
  // Re-runs only when the provider list or signed-in user changes; we
  // intentionally don't depend on `providerId` so we never clobber a manual
  // pick the clinician makes after the initial auto-select.
  useEffect(() => {
    if (providers.length === 0) return;
    const currentExists = providers.some((p) => p.id === providerId);
    if (!providerId || !currentExists) {
      const matchedId = findProviderForUser(providers, {
        name: authUserName,
        email: authUserEmail,
      });
      setProviderId(matchedId ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers, authUserName, authUserEmail]);

  // Patient search — always fetch fresh from the Eclipse API on every
  // provider/date/location change. We deliberately do NOT paint from cache
  // first: a stale cache occasionally surfaced the previous date's patients
  // when switching dates. The cache is now used only as an offline fallback
  // when the network request fails. A local `cancelled` flag prevents a
  // late-arriving response from a previous selection from overwriting state.
  useEffect(() => {
    setSelectedPatient(null);
    setPatientQuery("");
    setPatientLoadError(null);

    if (!providerId) {
      setPatients([]);
      setAllPatients([]);
      setPatientsLoading(false);
      return;
    }

    let cancelled = false;

    // Clear any rows from the previous provider/date and show loading. This
    // guarantees the user never sees the prior selection's patients.
    setPatients([]);
    setAllPatients([]);
    setPatientsLoading(true);

    // Apply a resolved patient list to state (+ optionally persist to cache),
    // with auto-select for today's schedule.
    const applyList = (list: PatientSearchResult[], persist: boolean) => {
      const sortedList = [...list].sort((a, b) =>
        normalize(`${a.last_name} ${a.first_name}`).localeCompare(
          normalize(`${b.last_name} ${b.first_name}`),
        ),
      );
      if (persist) {
        setCachedPatients(providerId, appointmentDate, eclipseLocation, sortedList);
      }
      if (cancelled) return;
      setAllPatients(sortedList);
      setPatients(sortedList);
      if (appointmentDate === getEtDateIso()) {
        // Don't clobber a manual selection the user already made.
        setSelectedPatient((existing) => {
          if (existing) return existing;
          return findClosestAppointment(sortedList, getEtMinutesNow()) ?? null;
        });
      }
    };

    (async () => {
      try {
        // Always go to the API so the list matches the selected date exactly.
        const list = await fetchPatientsByProviderDate(
          providerId,
          appointmentDate,
          "",
          eclipseLocation,
        );
        if (cancelled) return;
        applyList(list, true);
      } catch (err) {
        if (cancelled) return;
        // Network failure (e.g. offline) — fall back to cached rows for this
        // exact (provider, date, location) so the screen still works.
        const disk = await getCachedPatients(
          providerId,
          appointmentDate,
          eclipseLocation,
        ).catch(() => null);
        if (cancelled) return;
        if (
          disk &&
          (disk.status === "fresh" || disk.status === "stale") &&
          disk.patients.length > 0
        ) {
          applyList(disk.patients, false);
        } else {
          setPatientLoadError(
            err instanceof Error ? err.message : "Failed to load patients",
          );
        }
      } finally {
        if (!cancelled) setPatientsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [providerId, appointmentDate, apiUrl, eclipseLocation]);

  // Local filtering when user types
  useEffect(() => {
    const q = normalize(patientQuery);
    if (!q) {
      setPatients(allPatients);
      return;
    }

    const filtered = allPatients.filter((p) => {
      const fullName = normalize(`${p.first_name} ${p.last_name}`);
      const reverseName = normalize(`${p.last_name} ${p.first_name}`);
      return (
        normalize(p.first_name).includes(q) ||
        normalize(p.last_name).includes(q) ||
        fullName.includes(q) ||
        reverseName.includes(q) ||
        normalize(p.mrn).includes(q) ||
        normalize(p.id).includes(q)
      );
    });

    setPatients(filtered);

    // Auto-select exact match
    const exact =
      allPatients.find((p) => normalize(p.mrn) === q) ||
      allPatients.find((p) => normalize(p.id) === q);
    if (exact) {
      setSelectedPatient(exact);
      setPatientQuery("");
    }
  }, [patientQuery, allPatients]);

  const stopStatusPolling = useCallback(() => {
    if (statusPollRef.current) {
      clearInterval(statusPollRef.current);
      statusPollRef.current = null;
    }
    if (statusPollTimeoutRef.current) {
      clearTimeout(statusPollTimeoutRef.current);
      statusPollTimeoutRef.current = null;
    }
  }, []);

  // Cleanup
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (noteTimerRef.current) clearInterval(noteTimerRef.current);
      wsRef.current?.close();
      stopStatusPolling();
      if (asrReadIntervalRef.current) clearInterval(asrReadIntervalRef.current);
      asrWsRef.current?.close();
    };
  }, [stopStatusPolling]);

  // ---- Recording ----
  const ensureProviderAndPatient = (): boolean => {
    // Defense in depth: even though the Record / Upload buttons are visually
    // disabled until provider + patient are set, guard the actual functions
    // too. Prevents a recording from starting with empty demographics that
    // would later fail upload (provider_name is required by the pipeline).
    if (!providerId) {
      Alert.alert("Select a provider", "Please select a provider before recording.");
      return false;
    }
    if (!selectedPatient) {
      Alert.alert("Select a patient", "Please select a patient before recording.");
      return false;
    }
    return true;
  };

  const startRecording = async () => {
    if (!ensureProviderAndPatient()) return;
    try {
      const existingPerm = await Audio.getPermissionsAsync();
      let justGrantedNow = false;
      if (!existingPerm.granted) {
        const perm = await Audio.requestPermissionsAsync();
        if (!perm.granted) {
          Alert.alert("Permission required", "Microphone access is needed to record audio.");
          return;
        }
        justGrantedNow = true;
      }

      // On first allow, iOS can briefly report permission granted but audio
      // session is not yet fully ready for recorder creation.
      if (justGrantedNow) {
        await new Promise((resolve) => setTimeout(resolve, 450));
      }

      const configureRecordingMode = async () => {
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: true,
          playsInSilentModeIOS: true,
        });
      };

      await configureRecordingMode();
      const liveRecordingOptions: Audio.RecordingOptions = {
        isMeteringEnabled: true,
        ios: {
          extension: ".wav",
          outputFormat: Audio.IOSOutputFormat.LINEARPCM,
          audioQuality: Audio.IOSAudioQuality.MAX,
          sampleRate: 16000,
          numberOfChannels: 1,
          bitRate: 256000,
          linearPCMBitDepth: 16,
          linearPCMIsBigEndian: false,
          linearPCMIsFloat: false,
        },
        android: {
          extension: ".wav",
          outputFormat: Audio.AndroidOutputFormat.DEFAULT,
          audioEncoder: Audio.AndroidAudioEncoder.DEFAULT,
          sampleRate: 16000,
          numberOfChannels: 1,
          bitRate: 128000,
        },
        web: {},
      };
      let rec: Audio.Recording | null = null;
      try {
        const created = await Audio.Recording.createAsync(liveRecordingOptions);
        rec = created.recording;
        liveAsrFormatRef.current = "pcm";
      } catch {
        try {
          // Retry after resetting mode; first permission grant can race.
          await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
          await new Promise((resolve) => setTimeout(resolve, 180));
          await configureRecordingMode();
          const createdRetry = await Audio.Recording.createAsync(liveRecordingOptions);
          rec = createdRetry.recording;
          liveAsrFormatRef.current = "pcm";
        } catch {
          // Fallback to stable preset so recording still works.
          await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
          await new Promise((resolve) => setTimeout(resolve, 120));
          await configureRecordingMode();
          const fallback = await Audio.Recording.createAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
          rec = fallback.recording;
          liveAsrFormatRef.current = "none";
        }
      }

      if (!rec) {
        throw new Error("Failed to initialize recording");
      }
      setRecording(rec);
      setRecordingUri(null);
      setDuration(0);
      setAudioFilename(liveAsrFormatRef.current === "pcm" ? "recording.wav" : "recording.m4a");
      setAsrPartialText("");
      setAsrFinalSegments([]);
      setAsrError(null);
      setAsrStatus("");
      setStage("recording");
      timerRef.current = setInterval(() => setDuration((d) => d + 1), 1000);
      const recUri = rec.getURI();
      if (recUri && liveAsrFormatRef.current === "pcm") {
        startLiveTranscription(recUri, mode);
      } else if (liveAsrFormatRef.current !== "pcm") {
        setAsrError("Live transcription unavailable for this recording. Try recording again.");
      }
    } catch (err) {
      Alert.alert("Error", "Could not start recording.");
    }
  };

  const stopRecording = async () => {
    if (!recording) return;
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    await recording.stopAndUnloadAsync();
    await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
    await stopLiveTranscription();
    const uri = recording.getURI();
    setRecordingUri(uri);
    if (uri?.toLowerCase().endsWith(".wav")) setAudioFilename("recording.wav");
    else setAudioFilename("recording.m4a");
    setRecording(null);
    setStage("idle");
  };

  const pickAudioFile = async () => {
    if (!ensureProviderAndPatient()) return;
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: "audio/*",
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled || !result.assets?.length) {
        return;
      }

      const asset = result.assets[0];
      if (!asset.uri) return;

      setRecordingUri(asset.uri);
      setAudioFilename(asset.name || "uploaded-audio.m4a");
      setDuration(0);
      setStage("idle");
    } catch {
      Alert.alert("Error", "Could not pick audio file.");
    }
  };

  const pickNoteAudioFile = async (): Promise<{ uri: string; name: string } | null> => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: "audio/*",
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled || !result.assets?.length) return null;
      const asset = result.assets[0];
      if (!asset.uri) return null;
      return { uri: asset.uri, name: asset.name || "note_audio.m4a" };
    } catch {
      Alert.alert("Error", "Could not pick notes audio file.");
      return null;
    }
  };

  const startNoteRecording = async () => {
    try {
      const perm = await Audio.requestPermissionsAsync();
      if (!perm.granted) {
        Alert.alert("Permission required", "Microphone access is needed to record notes.");
        return;
      }
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });
      const { recording: rec } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY,
      );
      setNoteRecording(rec);
      setNoteDuration(0);
      setNoteAudioUri(null);
      setNoteAudioFilename("note_audio.m4a");
      noteTimerRef.current = setInterval(() => setNoteDuration((d) => d + 1), 1000);
    } catch {
      Alert.alert("Error", "Could not start notes recording.");
    }
  };

  const stopNoteRecording = async () => {
    if (!noteRecording) return;
    if (noteTimerRef.current) {
      clearInterval(noteTimerRef.current);
      noteTimerRef.current = null;
    }
    await noteRecording.stopAndUnloadAsync();
    await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
    const uri = noteRecording.getURI();
    const noteName = "note_recording.m4a";
    setNoteRecording(null);
    setNoteAudioUri(uri);
    setNoteAudioFilename(noteName);
    setNoteDuration(0);
  };

  const clearNoteAudio = () => {
    if (noteTimerRef.current) {
      clearInterval(noteTimerRef.current);
      noteTimerRef.current = null;
    }
    setNoteDuration(0);
    setNoteAudioUri(null);
    setNoteAudioFilename("note_audio.m4a");
    if (noteRecording) {
      const current = noteRecording;
      setNoteRecording(null);
      void current.stopAndUnloadAsync().catch(() => {});
      void Audio.setAudioModeAsync({ allowsRecordingIOS: false }).catch(() => {});
    }
  };

  const discardRecording = () => {
    void stopLiveTranscription();
    setRecordingUri(null);
    setDuration(0);
    setAudioFilename("recording.m4a");
    clearNoteAudio();
  };

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  const startLiveTranscription = (recordingUri: string, currentMode: string) => {
    const base = getApiUrl().replace(/\/$/, "");
    const wsBase = base.replace(/^http/, "ws");
    const asrId = `live_${Date.now()}`;
    const key = getApiKey();
    const wsMode = currentMode === "ambient" ? "ambient" : "dictation";
    const wsFormat = "pcm";
    const providerForAsr =
      String(selectedPatient?.provider_source_id || "").trim() ||
      String(providerId || "").replace(/^name:/, "").trim();
    const wsUrl =
      `${wsBase}/ws/asr/${asrId}?mode=${encodeURIComponent(wsMode)}&format=${encodeURIComponent(wsFormat)}` +
      `${key ? `&token=${encodeURIComponent(key)}` : ""}` +
      `${providerForAsr ? `&provider_id=${encodeURIComponent(providerForAsr)}` : ""}`;

    try {
      const ws = new WebSocket(wsUrl);
      asrWsRef.current = ws;
      ws.onopen = () => {
        setAsrStreaming(true);
        asrReadOffsetRef.current = 0;
        asrChunksSentRef.current = 0;
        asrPcmHeaderSkippedRef.current = false;
        asrPcmHeaderLenRef.current = 0;
        setAsrError(null);
        setAsrStatus("Connected. Listening...");
        console.log("[ASR] WS open — recording uri:", recordingUri);
        fetch(`${base}/asr/preload?mode=${encodeURIComponent(wsMode)}`, {
          method: "POST",
          headers: key ? { Authorization: `Bearer ${key}` } : {},
        }).catch(() => {});

        // Polling cadence:
        //   - Tighter interval (300 ms) catches iOS flushes sooner, which
        //     keeps perceived latency low and avoids large monolithic chunks.
        //   - On iOS, AVAudioRecorder may not flush PCM bytes to disk
        //     instantly; if the file still reports size 0, we just no-op and
        //     try again — the next flush will pick up everything new.
        asrReadIntervalRef.current = setInterval(async () => {
          try {
            const info = (await FileSystem.getInfoAsync(recordingUri, { size: true } as any)) as any;
            const size = typeof info?.size === "number" ? info.size : 0;
            const offset = asrReadOffsetRef.current;
            if (!size || size <= offset) return;
            const b64 = await FileSystem.readAsStringAsync(recordingUri, {
              encoding: FileSystem.EncodingType.Base64,
              position: offset,
              length: size - offset,
            } as any);
            if (!b64) return;
            let bytes = base64ToUint8Array(b64);

            if (!asrPcmHeaderSkippedRef.current) {
              // Locate the WAV "data" chunk dynamically — header length on
              // iOS varies (44 / 46 / 60 / 78+ bytes depending on options).
              // Without this, the first few audio "samples" we send are
              // actually stale header bytes, which makes the ASR engine
              // emit nothing for the opening seconds of the recording.
              const dataOffset = findWavDataOffset(bytes);
              if (dataOffset < 0) {
                // Header didn't fully arrive yet — wait for next poll.
                console.log("[ASR] waiting for WAV data chunk; have", bytes.byteLength, "bytes so far");
                return;
              }
              asrPcmHeaderLenRef.current = dataOffset;
              bytes = bytes.slice(dataOffset);
              asrPcmHeaderSkippedRef.current = true;
              console.log("[ASR] WAV header parsed: data chunk starts at byte", dataOffset);
            }

            if (bytes.byteLength > 0 && asrWsRef.current?.readyState === WebSocket.OPEN) {
              const payload = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
              asrWsRef.current.send(payload);
              asrReadOffsetRef.current = size;
              asrChunksSentRef.current += 1;
              if (asrChunksSentRef.current === 1 || asrChunksSentRef.current % 10 === 0) {
                console.log(
                  "[ASR] sent chunk",
                  asrChunksSentRef.current,
                  `(${bytes.byteLength} B, total file size ${size} B)`,
                );
              }
              setAsrStatus("Transcribing...");
            }
          } catch (err) {
            console.warn("[ASR] read/send error:", err);
          }
        }, 300);

        // Watchdog: if iOS hasn't flushed any audio to disk after ~15 s, warn
        // the user. The previous 6 s threshold was too aggressive — real
        // first-flushes on iOS can take 8–12 s on cold starts.
        setTimeout(() => {
          if (asrChunksSentRef.current === 0 && asrWsRef.current?.readyState === WebSocket.OPEN) {
            console.warn("[ASR] no audio chunks sent after 15s — file may not be flushing on this device");
            setAsrError("Live ASR connected but no audio chunks detected yet.");
          }
        }, 15000);
      };
      ws.onmessage = (event) => {
        try {
          const raw = String(event.data);
          if (asrChunksSentRef.current <= 5) {
            console.log("[ASR] WS←", raw.slice(0, 240));
          }
          const data = JSON.parse(raw);
          const eventType = String(data.type || "").toLowerCase();
          const text = String(data.text || "").trim();
          const partial = String(data.partial || "").trim();
          const final = String(data.final || data.segment || data.transcript || "").trim();
          const finalText = final || (eventType === "final" ? text : "");
          const partialText = partial || (eventType === "partial" ? text : "");

          if (eventType === "complete") {
            const completeText = String(data.transcript || text || "").trim();
            if (completeText) {
              setAsrFinalSegments((prev) => [...prev, completeText]);
            }
            setAsrPartialText("");
            setAsrStatus("Transcription complete.");
            return;
          }

          if (finalText) {
            setAsrFinalSegments((prev) => [...prev, finalText]);
            setAsrPartialText("");
            setAsrStatus("Receiving transcript...");
          } else if (partialText || text) {
            setAsrPartialText(partialText || text);
            setAsrStatus("Receiving transcript...");
          }
        } catch {
          const msg = String(event.data || "").trim();
          if (msg) setAsrPartialText(msg);
        }
      };
      // Track close info so we can surface a precise on-screen diagnostic
      // (Release builds skip Metro, so console.log isn't visible without
      // an Xcode/devicectl log session — the screen text is the most
      // reliable channel for the QA loop).
      const wsHost = (() => {
        try {
          const u = wsUrl.replace(/^ws/, "http");
          return new URL(u).host;
        } catch {
          return "ws://?";
        }
      })();
      ws.onerror = (ev) => {
        const m = (ev as any)?.message;
        console.warn("[ASR] WS error", ev);
        setAsrError(`Live transcription connection error (${wsHost}${m ? `: ${m}` : ""})`);
      };
      ws.onclose = (ev) => {
        const code = (ev as any)?.code;
        const reason = (ev as any)?.reason;
        console.log("[ASR] WS close", code, reason);
        // If we never received the "connected" frame, surface the close
        // code/reason directly on screen — that's the single best signal
        // for whether iOS rejected the handshake (TLS / ATS), the server
        // rejected the upgrade (auth / WAF), or the connection died
        // mid-stream (idle timeout / NAT).
        if (asrChunksSentRef.current === 0) {
          const detail = `code=${code ?? "?"}${reason ? ` ${reason}` : ""}`;
          setAsrError(`Live transcription closed before audio (${wsHost} ${detail})`);
        }
        setAsrStreaming(false);
        setAsrStatus("");
      };
    } catch (err) {
      console.warn("[ASR] start failed:", err);
      const msg = err instanceof Error ? err.message : String(err);
      setAsrError(`Unable to start live transcription: ${msg}`);
    }
  };

  const stopLiveTranscription = async () => {
    if (asrReadIntervalRef.current) {
      clearInterval(asrReadIntervalRef.current);
      asrReadIntervalRef.current = null;
    }
    if (asrWsRef.current && asrWsRef.current.readyState === WebSocket.OPEN) {
      try {
        asrWsRef.current.close();
      } catch {}
    }
    asrWsRef.current = null;
    asrPcmHeaderSkippedRef.current = false;
    setAsrStreaming(false);
    setAsrStatus("");
  };

  // ---- Submit ----
  const canSubmit = providerId && selectedPatient && recordingUri && stage === "idle";
  const submitButtonLabel = mode === "ambient" ? "Submit Conversation" : "Submit Dictation";

  const handleSubmit = useCallback(async (notesOverride?: { uri: string; name: string } | null) => {
    if (!selectedPatient || !recordingUri) return;
    const effectiveNoteAudioUri = notesOverride?.uri ?? noteAudioUri;
    const effectiveNoteAudioFilename = notesOverride?.name ?? noteAudioFilename;

    // Resolve visit_type from the Eclipse/Micro `new_repeat_patient` flag (the
    // field web uses): "New" → "initial_evaluation", "Repeat" → "follow_up",
    // for both locations. Falls back to the prior per-location logic only when
    // the flag is missing (PA → "default", Baltimore → infer from appt class).
    const visitType = resolveVisitType(
      eclipseLocation,
      selectedPatient.appointment_class,
      selectedPatient.new_repeat_patient,
    );

    // Check connectivity
    const online = await checkConnectivity();
    if (!online) {
      await enqueue({
        provider_id: providerId,
        patient_id: selectedPatient.id,
          visit_type: visitType,
        mode,
        audioUri: recordingUri,
          filename: audioFilename,
      });
      Alert.alert(
        "Saved Offline",
        "No network connection. Your recording has been saved and will be uploaded automatically when connectivity is restored.",
      );
      discardRecording();
      return;
    }

    try {
      setStage("creating");
      setStatusMsg("Creating encounter...");
      setProgress(0);
      const selectedProviderName = providers.find((p) => p.id === providerId)?.name;
      const encounterProviderId = await resolveEncounterProviderId(providerId, selectedProviderName);
      const patientCaseId =
        String(selectedPatient.patient_case_id || "").trim() ||
        String(selectedPatient.mrn || "").trim() ||
        String(selectedPatient.id || "").trim();
      const patientNameForRequest = formatPatientNameLastFirst(
        selectedPatient.first_name,
        selectedPatient.last_name,
      );
      const providerIdCandidate =
        String(selectedPatient.provider_source_id || "").trim() ||
        String(encounterProviderId || "").trim() ||
        String(providerId || "").trim();
      const providerIdForEncounter = providerIdCandidate.startsWith("name:")
        ? providerIdCandidate.replace(/^name:/, "")
        : providerIdCandidate;
      const clientEncounterId = resolveClientEncounterId({
        appointmentId: selectedPatient.appointment_id,
        patientCaseId,
        providerId: providerIdForEncounter,
        dateOfService: appointmentDate,
        location: eclipseLocation,
      });

      let enc;
      try {
        enc = await createEncounter({
          encounter_id: clientEncounterId,
          provider_id: encounterProviderId,
          patient_id: selectedPatient.id,
          patient_name: patientNameForRequest || undefined,
            visit_type: visitType,
          mode,
          date_of_service: appointmentDate,
          created_at: new Date().toISOString(),
          audio_file: audioFilename,
          note_audio_file: effectiveNoteAudioUri ? effectiveNoteAudioFilename : null,
          has_gold_standard: false,
        });
      } catch (err) {
        // Retry once with a known-valid fallback provider for stability if mapping is rejected.
        if (
          encounterProviderId !== "dr_caleb_ademiloye" &&
          err instanceof Error &&
          err.message.includes("500")
        ) {
          enc = await createEncounter({
            encounter_id: clientEncounterId,
            provider_id: "dr_caleb_ademiloye",
            patient_id: selectedPatient.id,
            patient_name: patientNameForRequest || undefined,
              visit_type: visitType,
            mode,
            date_of_service: appointmentDate,
            created_at: new Date().toISOString(),
            audio_file: audioFilename,
            note_audio_file: effectiveNoteAudioUri ? effectiveNoteAudioFilename : null,
            has_gold_standard: false,
          });
        } else {
          throw err;
        }
      }

      const effectiveEncounterId = enc.encounter_id || clientEncounterId;

      // Connect WebSocket for progress
      const ws = new WebSocket(`${getWsUrl()}/ws/encounters/${effectiveEncounterId}`);
      wsRef.current = ws;

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === "progress") {
          setProgress(data.pct ?? 0);
          setStatusMsg(data.message ?? `Stage: ${data.stage}`);
        } else if (data.type === "complete") {
          setStage("complete");
          setProgress(100);
          setStatusMsg("Pipeline complete — note generated");
          setResultSampleId(data.sample_id ?? null);
          stopStatusPolling();
          ws.close();
        } else if (data.type === "error") {
          setStage("error");
          setStatusMsg(data.error ?? "Pipeline error");
          stopStatusPolling();
          ws.close();
        }
      };

      ws.onerror = () => {
        if (stage !== "complete" && stage !== "error") {
          setStatusMsg("Running pipeline (live updates unavailable)");
        }
      };

      setStage("uploading");
      setStatusMsg("Uploading audio...");
      setProgress(5);

      // Build the demographics blob the AI Scribe pipeline relies on to
      // route uploads to the correct SFTP / MT folders and to slug the
      // generated note. Without this the backend can't distinguish a
      // Pennsylvania run from a Baltimore one — the web app sends the same
      // payload via its capture flow.
      const demographics = buildEncounterDetailsFromPatient({
        patient: selectedPatient,
        providerName: selectedProviderName || patientNameForRequest || "Unknown",
        systemLocation: eclipseLocation,
        date: appointmentDate,
      });

      // Set EXPO_PUBLIC_DEBUG_DEMOGRAPHICS=1 in .env — popup before upload (case # + D/ACCIDENT).
      if (__DEV__ || process.env.EXPO_PUBLIC_DEBUG_DEMOGRAPHICS === "1") {
        const debugBody = formatEncounterDetailsDebugMessage({
          demographics,
          patient: selectedPatient,
          systemLocation: eclipseLocation,
        });
        console.log("[Talix] encounter_details", JSON.stringify(demographics, null, 2));
        console.log("[Talix] upload debug\n", debugBody);
        await new Promise<void>((resolve) => {
          Alert.alert(
            eclipseLocation === "baltimore"
              ? "Baltimore upload (debug)"
              : "Pennsylvania upload (debug)",
            debugBody,
            [{ text: "Continue upload", onPress: () => resolve() }],
          );
        });
      }

      const result = await uploadEncounterAudio(
        effectiveEncounterId,
        recordingUri,
        audioFilename,
        effectiveNoteAudioUri,
        effectiveNoteAudioFilename,
        demographics,
      );

      setStage("processing");
      setStatusMsg(result.message ?? "Pipeline running...");
      setResultSampleId(result.sample_id);
      setProgress(10);

      // Start polling fallback. Even if every WS message is dropped between
      // the device and the server (AWS WAF / ALB idle timeout / mobile NAT /
      // RN WebSocket quirks), the pipeline still completes on the backend.
      // Polling /encounters/{id}/status guarantees the UI flips to "complete"
      // once the server says so, instead of sitting on "Audio received —
      // pipeline running" forever.
      stopStatusPolling();
      const pollStartedAt = Date.now();
      const POLL_INTERVAL_MS = 4000;
      const POLL_MAX_MS = 15 * 60 * 1000; // safety cap: 15 minutes
      statusPollRef.current = setInterval(async () => {
        try {
          const s = await fetchEncounterStatus(effectiveEncounterId);
          const normalized = (s.status || "").toLowerCase();
          if (normalized === "complete") {
            setStage("complete");
            setProgress(100);
            setStatusMsg("Pipeline complete — note generated");
            setResultSampleId(s.sample_id ?? null);
            stopStatusPolling();
            wsRef.current?.close();
          } else if (normalized === "error" || normalized === "failed") {
            setStage("error");
            setStatusMsg(s.message || "Pipeline error");
            stopStatusPolling();
            wsRef.current?.close();
          } else if (Date.now() - pollStartedAt > POLL_MAX_MS) {
            stopStatusPolling();
          }
        } catch {
          // Transient poll failures (offline blip, 5xx) shouldn't kill the
          // poller — the next tick will retry. Hard-stop only on the
          // overall time cap above.
        }
      }, POLL_INTERVAL_MS);
      statusPollTimeoutRef.current = setTimeout(stopStatusPolling, POLL_MAX_MS);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      // Surfaces in the Metro terminal when debugging on device (npx expo start).
      console.error("[submit]", message, err);
      setStage("error");
      setStatusMsg(message);
    }
  }, [
    providerId,
    selectedPatient,
    recordingUri,
    mode,
    stage,
    eclipseLocation,
    checkConnectivity,
    enqueue,
    audioFilename,
    noteAudioUri,
    noteAudioFilename,
  ]);

  const handleSubmitPress = useCallback(() => {
    if (mode !== "ambient") {
      void handleSubmit();
      return;
    }
    if (noteRecording) {
      Alert.alert("Notes recording in progress", "Stop notes recording before submitting.");
      return;
    }
    if (noteAudioUri) {
      void handleSubmit({ uri: noteAudioUri, name: noteAudioFilename });
      return;
    }

    Alert.alert(
      "Add Conversation Notes?",
      "Would you like to add notes before submitting this conversation?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "No, Submit Without Notes",
          onPress: () => {
            clearNoteAudio();
            void handleSubmit();
          },
        },
        {
          text: "Yes, Add Notes",
          onPress: () => {
            Alert.alert("Add Notes", "How would you like to add notes?", [
              { text: "Cancel", style: "cancel" },
              {
                text: "Record Notes",
                onPress: () => {
                  void startNoteRecording();
                },
              },
              {
                text: "Upload Notes",
                onPress: async () => {
                  const picked = await pickNoteAudioFile();
                  if (!picked) return;
                  setNoteAudioUri(picked.uri);
                  setNoteAudioFilename(picked.name);
                },
              },
            ]);
          },
        },
      ],
    );
  }, [mode, handleSubmit, noteAudioUri, noteAudioFilename, noteRecording]);

  const resetForm = () => {
    setStage("idle");
    setStatusMsg("");
    setProgress(0);
    setResultSampleId(null);
    setMode("ambient");
    setSelectedPatient(null);
    setPatientQuery("");
    discardRecording();
    wsRef.current?.close();
    stopStatusPolling();
  };

  // ---- Render ----
  const normalizedProviderQuery = normalize(providerQuery);
  const filteredProviders = providers.filter((p) => {
    if (!normalizedProviderQuery) return true;
    return (
      normalize(p.name).includes(normalizedProviderQuery) ||
      normalize(p.id).includes(normalizedProviderQuery)
    );
  });

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + spacing.lg },
        isTablet && styles.tabletContent,
      ]}
    >
      <Text style={styles.title}>Record Encounter</Text>
      <Text style={styles.subtitle}>Capture audio to generate a clinical note</Text>

      {!isOnline && (
        <Card style={{ backgroundColor: "#FEF3C7", borderColor: "#F59E0B" }}>
          <View style={styles.row}>
            <Ionicons name="cloud-offline" size={18} color="#92400E" />
            <Text style={{ color: "#92400E", fontSize: fontSize.sm, marginLeft: spacing.sm }}>
              Offline — recordings will be queued for upload
            </Text>
          </View>
        </Card>
      )}

      {/* Location — selects which Eclipse source_system (Pennsylvania=Eclipse,
          Baltimore=Micro) drives the provider + patient queries. Persisted in
          settings so it carries across sessions. Segmented control style
          matches the Mode chooser below for a consistent feel. */}
      <Card>
        <Text style={styles.label}>Location</Text>
        <Text style={styles.sublabel}>
          Choose the office whose schedule you’re working from. Switching
          locations refreshes the provider and patient lists.
        </Text>
        <View style={[styles.modeOptionsRow, { marginTop: spacing.sm }]}>
          {(["pennsylvania", "baltimore"] as EclipseLocation[]).map((loc) => {
            const active = eclipseLocation === loc;
            return (
              <TouchableOpacity
                key={loc}
                onPress={() => {
                  if (loc !== eclipseLocation) setEclipseLocation(loc);
                }}
                style={[styles.modeOptionCard, active && styles.modeOptionCardActive]}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
              >
                <Text
                  style={[styles.modeOptionTitle, active && styles.modeOptionTitleActive]}
                >
                  {ECLIPSE_LOCATION_LABEL[loc]}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </Card>

      {/* Provider */}
      <Card>
        <Text style={styles.label}>Provider</Text>
        {!providersLoaded ? (
          <>
            <Text style={styles.sublabel}>Loading providers...</Text>
            <SkeletonList count={4} />
          </>
        ) : providers.length === 0 ? (
          <Text style={styles.sublabel}>
            {providerLoadError ? `Unable to load providers: ${providerLoadError}` : "No providers found."}
          </Text>
        ) : providerId && !providerPickerOpen ? (
          // Collapsed selected state: shows just the chosen provider plus a
          // "Change" affordance, so a stray tap can't pick a different name.
          <TouchableOpacity
            style={styles.selectedProviderBanner}
            onPress={() => {
              setProviderQuery("");
              setProviderPickerOpen(true);
            }}
            activeOpacity={0.7}
          >
            <Ionicons name="checkmark-circle" size={18} color={colors.brand} />
            <Text style={styles.selectedProviderText} numberOfLines={1}>
              {providers.find((p) => p.id === providerId)?.name ?? providerId}
            </Text>
            <Text style={styles.selectedProviderChange}>Change</Text>
            <Ionicons name="chevron-down" size={16} color={colors.brand} />
          </TouchableOpacity>
        ) : (
          <>
            <View style={styles.searchBox}>
              <Ionicons name="search" size={16} color={colors.textTertiary} />
              <TextInput
                value={providerQuery}
                onChangeText={setProviderQuery}
                placeholder="Search providers..."
                style={styles.searchInput}
                placeholderTextColor={colors.textTertiary}
                autoFocus={providerPickerOpen}
              />
              {providerId ? (
                <TouchableOpacity onPress={() => setProviderPickerOpen(false)}>
                  <Ionicons name="close" size={18} color={colors.textTertiary} />
                </TouchableOpacity>
              ) : null}
            </View>
            <Text style={styles.providerCountText}>
              Showing {filteredProviders.length} of {providers.length} providers
            </Text>
            <FlatList
              data={filteredProviders}
              keyExtractor={(p) => p.id}
              style={styles.providerListVertical}
              nestedScrollEnabled
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator
              renderItem={({ item }) => {
                const isActive = providerId === item.id;
                return (
                  <TouchableOpacity
                    style={[
                      styles.providerVerticalRow,
                      isActive && styles.providerVerticalRowActive,
                    ]}
                    onPress={() => {
                      setProviderId(item.id);
                      setProviderQuery("");
                      setProviderPickerOpen(false);
                    }}
                    activeOpacity={0.7}
                  >
                    <Text
                      style={[
                        styles.providerVerticalRowText,
                        isActive && styles.providerVerticalRowTextActive,
                      ]}
                      numberOfLines={1}
                    >
                      {item.name ?? item.id}
                    </Text>
                    {isActive ? (
                      <Ionicons name="checkmark" size={18} color={colors.brand} />
                    ) : null}
                  </TouchableOpacity>
                );
              }}
              ItemSeparatorComponent={() => <View style={styles.providerVerticalSeparator} />}
              ListEmptyComponent={
                <Text style={styles.sublabel}>No providers found.</Text>
              }
            />
          </>
        )}

        {/* Appointment date is always visible (independent of provider picker
            collapsed/expanded state) once the provider list has loaded. */}
        {providersLoaded && providers.length > 0 ? (
          <>
            <Text style={styles.dateLabel}>Appointment Date</Text>
            {Platform.OS === "ios" ? (
              <View style={styles.iosDatePickerCompactWrap}>
                <DateTimePicker
                  value={parseIsoDate(appointmentDate)}
                  mode="date"
                  display="compact"
                  style={styles.iosDatePickerCompact}
                  onChange={(_event, selectedDate) => {
                    if (selectedDate) {
                      setAppointmentDate(formatIsoDate(selectedDate));
                    }
                  }}
                  maximumDate={new Date(2100, 11, 31)}
                  minimumDate={new Date(2000, 0, 1)}
                />
              </View>
            ) : (
              <TouchableOpacity
                style={styles.datePickerButton}
                onPress={() => {
                  // Android opens native date picker dialog directly.
                  DateTimePickerAndroid.open({
                    value: parseIsoDate(appointmentDate),
                    mode: "date",
                    onChange: (_event, selectedDate) => {
                      if (selectedDate) {
                        setAppointmentDate(formatIsoDate(selectedDate));
                      }
                    },
                    maximumDate: new Date(2100, 11, 31),
                    minimumDate: new Date(2000, 0, 1),
                  });
                }}
              >
                <Ionicons name="calendar-outline" size={16} color={colors.textTertiary} />
                <Text style={styles.datePickerText}>{formatDateUS(appointmentDate)}</Text>
                <Ionicons name="chevron-down" size={16} color={colors.textTertiary} />
              </TouchableOpacity>
            )}
          </>
        ) : null}
      </Card>

      {/* Patient */}
      <Card>
        <Text style={styles.label}>Patient</Text>
        {selectedPatient ? (
          <View style={styles.selectedPatient}>
            <View style={{ flex: 1 }}>
              <Text style={styles.patientName}>
                {getPatientDisplayName(selectedPatient)}
              </Text>
              <Text style={styles.patientMeta}>
                MRN: {selectedPatient.mrn} · DOB: {formatDateUS(selectedPatient.date_of_birth)}
              </Text>
            </View>
            <TouchableOpacity onPress={() => setSelectedPatient(null)}>
              <Ionicons name="close-circle" size={22} color={colors.textTertiary} />
            </TouchableOpacity>
          </View>
        ) : (
          <>
            <Text style={styles.sublabel}>
              Search by name or MRN, then tap a row — or type the exact MRN / patient ID to select automatically.
            </Text>
            <View style={styles.searchBox}>
              <Ionicons name="search" size={16} color={colors.textTertiary} />
              <TextInput
                value={patientQuery}
                onChangeText={setPatientQuery}
                placeholder="Search patients by name or MRN..."
                style={styles.searchInput}
                placeholderTextColor={colors.textTertiary}
              />
            </View>
            {/* While we're fetching AND have nothing rendered yet, show
                skeleton rows instead of a bare spinner — same trick the web
                achieves by SSR-populating the dropdown before paint. Once
                cached/fresh data is on screen we keep the spinner-style
                hint subtle so a background refresh doesn't flash the UI. */}
            {patientsLoading && patients.length === 0 ? (
              <SkeletonList count={5} />
            ) : patientsLoading ? (
              <View style={styles.patientLoadingRow}>
                <ActivityIndicator size="small" color={colors.brand} />
                <Text style={styles.patientLoadingText}>Refreshing patient list…</Text>
              </View>
            ) : null}
            <FlatList
              data={patients}
              keyExtractor={(p) => p.id}
              scrollEnabled
              nestedScrollEnabled
              style={{ maxHeight: 250, marginTop: spacing.sm }}
              renderItem={({ item }) => (
                <TouchableOpacity style={styles.patientRow} onPress={() => setSelectedPatient(item)}>
                  <Text style={styles.patientName}>
                    {getPatientDisplayName(item)}
                  </Text>
                  <Text style={styles.patientMeta}>
                    MRN: {item.mrn} · {item.sex} · {formatDateUS(item.date_of_birth)}
                  </Text>
                </TouchableOpacity>
              )}
              ListEmptyComponent={
                patientsLoading
                  ? null
                  : (
                    <Text style={styles.sublabel}>
                      {patientLoadError
                        ? `Unable to load patients: ${patientLoadError}`
                        : "No patients found. Try adjusting your search."}
                    </Text>
                  )
              }
            />
          </>
        )}
      </Card>

      {/* Visit type + mode */}
      <Card>
        <Text style={styles.label}>Encounter Details</Text>
        <View style={styles.detailsBlock}>
          <Text style={styles.detailLine}>
            <Text style={styles.detailLabel}>Date of Service: </Text>
            {formatDateForDisplay(appointmentDate)}
          </Text>
          <Text style={styles.detailLine}>
            <Text style={styles.detailLabel}>Patient Name: </Text>
            {selectedPatient ? getPatientDisplayName(selectedPatient) : "Not selected"}
          </Text>
          <Text style={styles.detailLine}>
            <Text style={styles.detailLabel}>Date of Birth: </Text>
            {selectedPatient?.date_of_birth ? formatDateUS(selectedPatient.date_of_birth) : "N/A"}
          </Text>
          <Text style={styles.detailLine}>
            <Text style={styles.detailLabel}>Provider: </Text>
            {(providers.find((p) => p.id === providerId)?.name ?? providerId) || "N/A"}
          </Text>
          <Text style={styles.detailLine}>
            <Text style={styles.detailLabel}>Location: </Text>
            {selectedPatient?.location || "N/A"}
          </Text>
        </View>

        <View style={{ marginTop: spacing.md }}>
          <Text style={styles.sublabel}>Mode</Text>
          <View style={styles.modeOptionsRow}>
            {MODES.map((m) => {
              const active = mode === m.value;
              return (
                <TouchableOpacity
                  key={m.value}
                  onPress={() => setMode(m.value)}
                  style={[styles.modeOptionCard, active && styles.modeOptionCardActive]}
                >
                  <Text style={[styles.modeOptionTitle, active && styles.modeOptionTitleActive]}>
                    {m.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      </Card>

      {/* Audio recording */}
      <Card>
        <Text style={styles.label}>Audio</Text>

        {!recordingUri ? (
          <View style={styles.recordSection}>
            <View style={{ flex: 1 }}>
              {(() => {
                // Recording is only meaningful with a provider + patient picked
                // (the pipeline rejects uploads with empty provider_name and
                // the resulting note would be unattributable). Block start at
                // the UI level; ensureProviderAndPatient() is the fallback.
                const isRecording = stage === "recording";
                const prereqsMet = Boolean(providerId && selectedPatient);
                const recordDisabled =
                  isRecording ? false : !prereqsMet || (stage !== "idle");
                return (
                  <>
                    <TouchableOpacity
                      style={[
                        styles.recordBtn,
                        isRecording && styles.recordBtnActive,
                        recordDisabled && styles.recordBtnDisabled,
                      ]}
                      onPress={isRecording ? stopRecording : startRecording}
                      disabled={recordDisabled}
                    >
                      <Ionicons
                        name={isRecording ? "stop" : "mic"}
                        size={32}
                        color={colors.textInverse}
                      />
                    </TouchableOpacity>
                    <View style={{ marginTop: spacing.sm }}>
                      {isRecording ? (
                        <>
                          <View style={styles.row}>
                            <View style={styles.pulseDot} />
                            <Text style={[styles.recordingLabel, { color: colors.error }]}>
                              Recording...
                            </Text>
                          </View>
                          <Text style={styles.timer}>{formatTime(duration)}</Text>
                        </>
                      ) : prereqsMet ? (
                        <Text style={styles.tapToRecord}>Tap to start recording</Text>
                      ) : (
                        <Text style={styles.tapToRecord}>
                          {!providerId
                            ? "Select a provider to start recording"
                            : "Select a patient to start recording"}
                        </Text>
                      )}
                    </View>
                  </>
                );
              })()}
            </View>
            <View style={{ marginLeft: spacing.md }}>
              {(() => {
                const prereqsMet = Boolean(providerId && selectedPatient);
                const uploadDisabled = stage === "recording" || !prereqsMet;
                return (
                  <>
                    <TouchableOpacity
                      style={[styles.uploadBtn, uploadDisabled && styles.uploadBtnDisabled]}
                      onPress={pickAudioFile}
                      disabled={uploadDisabled}
                    >
                      <Ionicons name="cloud-upload-outline" size={16} color={colors.text} />
                      <Text style={styles.uploadBtnText}>Upload Audio</Text>
                    </TouchableOpacity>
                    <Text style={styles.uploadHint}>
                      {prereqsMet
                        ? "Use an existing audio file"
                        : "Select provider & patient first"}
                    </Text>
                  </>
                );
              })()}
            </View>
          </View>
        ) : (
          <AudioPreviewCard
            uri={recordingUri}
            filename={audioFilename}
            label={
              duration > 0
                ? `Audio ready · ${formatTime(duration)}`
                : "Audio ready"
            }
            onDiscard={discardRecording}
          />
        )}
        {mode === "ambient" && recordingUri ? (
          <View style={styles.noteControls}>
            <Text style={styles.sublabel}>Conversation Notes</Text>
            {noteRecording ? (
              <>
                <View style={styles.row}>
                  <View style={styles.pulseDot} />
                  <Text style={[styles.recordingLabel, { color: colors.error }]}>
                    Recording Conversation... {formatTime(noteDuration)}
                  </Text>
                </View>
                <View style={[styles.row, { marginTop: spacing.sm }]}>
                  <TouchableOpacity style={styles.uploadBtn} onPress={stopNoteRecording}>
                    <Ionicons name="stop" size={16} color={colors.text} />
                    <Text style={styles.uploadBtnText}>Stop Recording</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.uploadBtn, { marginLeft: spacing.sm }]} onPress={clearNoteAudio}>
                    <Ionicons name="trash-outline" size={16} color={colors.text} />
                    <Text style={styles.uploadBtnText}>Discard</Text>
                  </TouchableOpacity>
                </View>
              </>
            ) : noteAudioUri ? (
              <>
                <AudioPreviewCard
                  uri={noteAudioUri}
                  filename={noteAudioFilename}
                  label="Notes audio ready"
                />
                <View style={[styles.row, { marginTop: spacing.sm }]}>
                  <TouchableOpacity
                    style={styles.uploadBtn}
                    onPress={async () => {
                      const picked = await pickNoteAudioFile();
                      if (!picked) return;
                      setNoteAudioUri(picked.uri);
                      setNoteAudioFilename(picked.name);
                    }}
                  >
                    <Ionicons name="cloud-upload-outline" size={16} color={colors.text} />
                    <Text style={styles.uploadBtnText}>Replace (Upload)</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.uploadBtn, { marginLeft: spacing.sm }]} onPress={startNoteRecording}>
                    <Ionicons name="mic" size={16} color={colors.text} />
                    <Text style={styles.uploadBtnText}>Replace (Record)</Text>
                  </TouchableOpacity>
                </View>
              </>
            ) : (
              <View style={styles.row}>
                <TouchableOpacity style={styles.uploadBtn} onPress={startNoteRecording}>
                  <Ionicons name="mic" size={16} color={colors.text} />
                  <Text style={styles.uploadBtnText}>Record Notes</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.uploadBtn, { marginLeft: spacing.sm }]}
                  onPress={async () => {
                    const picked = await pickNoteAudioFile();
                    if (!picked) return;
                    setNoteAudioUri(picked.uri);
                    setNoteAudioFilename(picked.name);
                  }}
                >
                  <Ionicons name="cloud-upload-outline" size={16} color={colors.text} />
                  <Text style={styles.uploadBtnText}>Upload Notes</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        ) : null}
        {stage === "recording" &&
          (asrStreaming ||
            asrPartialText ||
            asrFinalSegments.length > 0 ||
            asrError) && (
            <View style={styles.transcriptWrap}>
              <View style={styles.transcriptHeaderRow}>
                <View style={styles.transcriptLiveDot} />
                <Text style={styles.transcriptHeaderText}>
                  Live transcript · read-only preview
                </Text>
              </View>
              {asrError ? (
                <Text style={styles.transcriptError}>{asrError}</Text>
              ) : asrStatus ? (
                <Text style={styles.transcriptStatus}>{asrStatus}</Text>
              ) : null}
              <ScrollView
                ref={transcriptScrollRef}
                style={styles.transcriptScroll}
                contentContainerStyle={styles.transcriptScrollContent}
                nestedScrollEnabled
                showsVerticalScrollIndicator
                // Block any keyboard / focus interaction so it cannot be
                // mistaken for an editable text input.
                scrollEnabled
                onContentSizeChange={() => {
                  // Keep the latest transcript text visible as new segments stream in.
                  transcriptScrollRef.current?.scrollToEnd({ animated: true });
                }}
              >
                {asrFinalSegments.map((seg, idx) => (
                  <Text
                    key={`${idx}-${seg.slice(0, 10)}`}
                    style={styles.transcriptFinalText}
                    selectable={false}
                  >
                    {seg}
                  </Text>
                ))}
                {asrPartialText ? (
                  <Text
                    style={styles.transcriptPartialText}
                    selectable={false}
                  >
                    {asrPartialText}
                  </Text>
                ) : null}
              </ScrollView>
            </View>
          )}
      </Card>

      {/* Submit / Progress */}
      {stage === "idle" && (
        <TouchableOpacity
          style={[styles.submitBtn, !canSubmit && styles.submitBtnDisabled]}
          onPress={handleSubmitPress}
          disabled={!canSubmit}
        >
          <Text style={styles.submitBtnText}>{submitButtonLabel}</Text>
        </TouchableOpacity>
      )}

      {stage !== "idle" && stage !== "recording" && (
        <Card>
          <ProgressBar
            progress={progress}
            color={stage === "error" ? colors.error : colors.brand}
          />
          <View style={[styles.row, { marginTop: spacing.md }]}>
            {(stage === "creating" || stage === "uploading" || stage === "processing") && (
              <ActivityIndicator size="small" color={colors.brand} style={{ marginRight: spacing.sm }} />
            )}
            {stage === "complete" && (
              <Ionicons name="checkmark-circle" size={18} color={colors.brand} style={{ marginRight: spacing.sm }} />
            )}
            {stage === "error" && (
              <Ionicons name="close-circle" size={18} color={colors.error} style={{ marginRight: spacing.sm }} />
            )}
            <Text style={{ fontSize: fontSize.sm, color: stage === "error" ? colors.error : colors.text, flex: 1 }}>
              {statusMsg}
            </Text>
          </View>

          {stage === "complete" && resultSampleId && (
            <View style={[styles.row, { marginTop: spacing.lg }]}>
              <TouchableOpacity
                style={styles.viewNoteBtn}
                onPress={() => {
                  // Switch to Encounters tab with both EncountersList and EncounterDetail
                  // in the stack so the native back button works correctly.
                  nav.navigate("Encounters", {
                    screen: "EncounterDetail",
                    params: { sampleId: resultSampleId },
                    initial: false,
                  });
                }}
              >
                <Text style={{ color: colors.textInverse, fontWeight: "600", fontSize: fontSize.sm }}>View Note</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.newEncounterBtn} onPress={resetForm}>
                <Text style={{ color: colors.textSecondary, fontWeight: "600", fontSize: fontSize.sm }}>New Encounter</Text>
              </TouchableOpacity>
            </View>
          )}

          {stage === "error" && (
            <TouchableOpacity style={[styles.newEncounterBtn, { marginTop: spacing.md }]} onPress={resetForm}>
              <Text style={{ color: colors.textSecondary, fontWeight: "600", fontSize: fontSize.sm }}>Try Again</Text>
            </TouchableOpacity>
          )}
        </Card>
      )}

      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, gap: spacing.md },
  tabletContent: { maxWidth: 640, alignSelf: "center", width: "100%" },
  title: {
    fontSize: fontSize.xxl,
    fontWeight: "700",
    color: colors.brand,
    textAlign: "center",
  },
  subtitle: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    textAlign: "center",
    marginBottom: spacing.sm,
  },
  label: { fontSize: fontSize.sm, fontWeight: "600", color: colors.text },
  sublabel: { fontSize: fontSize.xs, fontWeight: "500", color: colors.textSecondary, marginBottom: spacing.xs },

  // Live transcript: compact ~3-line viewport shown only while recording, with
  // an unmistakably non-editable look (soft gray fill, no input-style border,
  // pulsing "live" header) so providers don't try to type corrections into it.
  transcriptWrap: {
    marginTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
  },
  transcriptHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    marginBottom: spacing.xs,
  },
  transcriptLiveDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.error, // red "REC" indicator
  },
  transcriptHeaderText: {
    fontSize: fontSize.xs,
    fontWeight: "600",
    color: colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  transcriptScroll: {
    maxHeight: 72, // ~3 lines at 13px font + 18px line-height + padding
    borderRadius: radius.sm,
    backgroundColor: "#F3F4F6", // soft gray fill — clearly not an input
  },
  transcriptScrollContent: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  transcriptFinalText: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    lineHeight: 18,
    marginTop: 2,
  },
  transcriptPartialText: {
    color: colors.textTertiary,
    fontSize: fontSize.sm,
    lineHeight: 18,
    marginTop: 2,
    fontStyle: "italic",
  },
  transcriptStatus: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
    marginBottom: spacing.xs,
  },
  transcriptError: {
    color: colors.error,
    fontSize: fontSize.xs,
    marginBottom: spacing.xs,
  },

  row: { flexDirection: "row", alignItems: "center" },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    marginRight: spacing.sm,
    backgroundColor: colors.card,
  },
  chipActive: { backgroundColor: colors.brand, borderColor: colors.brand },
  chipText: { fontSize: fontSize.xs, color: colors.textSecondary, fontWeight: "500" },
  chipTextActive: { color: colors.textInverse },
  detailsBlock: {
    marginTop: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: 4,
  },
  detailLine: {
    fontSize: fontSize.sm,
    color: colors.text,
  },
  detailLabel: {
    color: colors.textSecondary,
    fontWeight: "600",
  },
  modeOptionsRow: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  modeOptionCard: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  modeOptionCardActive: {
    borderColor: colors.brand,
    backgroundColor: "#ECFDF5",
  },
  modeOptionTitle: {
    fontSize: fontSize.sm,
    color: colors.text,
    fontWeight: "700",
  },
  modeOptionTitleActive: {
    color: colors.brand,
  },
  modeOptionDesc: {
    marginTop: 2,
    fontSize: fontSize.xs,
    color: colors.textSecondary,
    fontWeight: "500",
  },
  modeOptionDescActive: {
    color: colors.brand,
  },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
  },
  searchInput: { flex: 1, paddingVertical: spacing.sm, marginLeft: spacing.sm, fontSize: fontSize.sm, color: colors.text },
  dateLabel: {
    marginTop: spacing.xs,
    fontSize: fontSize.xs,
    color: colors.textSecondary,
    fontWeight: "500",
  },
  datePickerButton: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    paddingHorizontal: spacing.md,
    height: 42,
    marginTop: spacing.xs,
    marginBottom: spacing.xs,
  },
  datePickerText: {
    flex: 1,
    marginLeft: spacing.sm,
    fontSize: fontSize.sm,
    color: colors.text,
    fontWeight: "500",
  },
  iosDatePickerCompactWrap: {
    marginTop: spacing.xs,
    marginLeft: -20,
    alignSelf: "flex-start",
  },
  iosDatePickerCompact: {
    transform: [{ scale: 0.85 }],
  },
  listRow: { paddingVertical: spacing.sm, paddingHorizontal: spacing.sm, borderRadius: radius.sm },
  listRowActive: { backgroundColor: "#D1FAE5" },
  listRowName: { fontSize: fontSize.sm, color: colors.text },
  listRowNameActive: { color: colors.brand, fontWeight: "600" },
  providerCountText: {
    marginTop: spacing.xs,
    marginBottom: spacing.xs,
    fontSize: fontSize.xs,
    color: colors.textTertiary,
    fontWeight: "500",
  },
  providerList: {
    marginTop: spacing.xs,
    maxHeight: 92,
  },
  providerListRow: {
    minWidth: 180,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginRight: spacing.sm,
  },
  providerListRowActive: {
    borderColor: colors.brand,
    backgroundColor: "#D1FAE5",
  },
  providerListName: {
    fontSize: fontSize.sm,
    color: colors.text,
    fontWeight: "600",
  },
  providerListNameActive: {
    color: colors.brand,
  },
  selectedProviderBanner: {
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: "#86EFAC",
    backgroundColor: "#ECFDF5",
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  selectedProviderText: {
    color: colors.brand,
    fontSize: fontSize.sm,
    fontWeight: "600",
    flex: 1,
  },
  selectedProviderChange: {
    color: colors.brand,
    fontSize: fontSize.xs,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  // Vertical provider list shown when picking / changing a provider.
  providerListVertical: {
    marginTop: spacing.xs,
    maxHeight: 280,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.card,
  },
  providerVerticalRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  providerVerticalRowActive: {
    backgroundColor: "#ECFDF5",
  },
  providerVerticalRowText: {
    fontSize: fontSize.sm,
    color: colors.text,
    fontWeight: "500",
    flex: 1,
  },
  providerVerticalRowTextActive: {
    color: colors.brand,
    fontWeight: "700",
  },
  providerVerticalSeparator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderLight,
  },
  patientRow: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
  },
  patientLoadingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.xs,
    marginBottom: spacing.xs,
  },
  patientLoadingText: {
    fontSize: fontSize.xs,
    color: colors.textSecondary,
    fontWeight: "500",
  },
  patientName: { fontSize: fontSize.sm, fontWeight: "600", color: colors.text },
  patientMeta: { fontSize: fontSize.xs, color: colors.textSecondary, marginTop: 2 },
  selectedPatient: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#D1FAE5",
    borderRadius: radius.md,
    padding: spacing.md,
    marginTop: spacing.sm,
  },
  recordSection: { flexDirection: "row", alignItems: "center", marginTop: spacing.md },
  recordBtn: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.brand,
    alignItems: "center",
    justifyContent: "center",
  },
  recordBtnActive: { backgroundColor: colors.error },
  recordBtnDisabled: { backgroundColor: colors.border, opacity: 0.6 },
  pulseDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.error, marginRight: spacing.sm },
  recordingLabel: { fontSize: fontSize.sm, fontWeight: "600" },
  timer: { fontSize: fontSize.xxl, fontWeight: "700", fontVariant: ["tabular-nums"], color: colors.text, marginTop: 2 },
  tapToRecord: { fontSize: fontSize.sm, color: colors.textSecondary },
  uploadBtn: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    gap: spacing.xs,
  },
  uploadBtnText: {
    fontSize: fontSize.xs,
    color: colors.text,
    fontWeight: "600",
  },
  uploadBtnDisabled: { opacity: 0.5 },
  uploadHint: {
    marginTop: spacing.xs,
    fontSize: fontSize.xs,
    color: colors.textSecondary,
    maxWidth: 140,
  },
  recordedRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#D1FAE5",
    borderRadius: radius.md,
    padding: spacing.md,
    marginTop: spacing.md,
  },

  // Audio preview card — used for both the main recording and the notes
  // audio. Soft mint background with brand-green play button so it reads
  // as a positive "ready to verify" state and clearly separates each file.
  audioPreviewCard: {
    backgroundColor: "#ECFDF5",
    borderWidth: 1,
    borderColor: "#86EFAC",
    borderRadius: radius.md,
    padding: spacing.md,
    marginTop: spacing.sm,
    gap: spacing.sm,
  },
  audioPreviewHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  audioPreviewIconWrap: {
    width: 32,
    height: 32,
    borderRadius: radius.sm,
    backgroundColor: "#D1FAE5",
    alignItems: "center",
    justifyContent: "center",
  },
  audioPreviewLabel: {
    fontSize: fontSize.xs,
    fontWeight: "700",
    color: colors.brand,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  audioPreviewFilename: {
    fontSize: fontSize.sm,
    fontWeight: "600",
    color: colors.text,
    marginTop: 2,
  },
  audioPreviewControls: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  audioPlayBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.brand,
    alignItems: "center",
    justifyContent: "center",
  },
  audioPlayBtnDisabled: {
    backgroundColor: colors.textTertiary,
  },
  audioProgressHit: {
    flex: 1,
    height: 28,
    justifyContent: "center",
    paddingHorizontal: 6,
  },
  audioProgressTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: "#A7F3D0",
    overflow: "hidden",
  },
  audioProgressFill: {
    height: "100%",
    backgroundColor: colors.brand,
  },
  audioProgressThumb: {
    position: "absolute",
    top: "50%",
    width: 14,
    height: 14,
    marginLeft: -7,
    marginTop: -7,
    borderRadius: 7,
    backgroundColor: colors.brand,
    borderWidth: 2,
    borderColor: "#FFFFFF",
  },
  audioProgressThumbActive: {
    width: 18,
    height: 18,
    marginLeft: -9,
    marginTop: -9,
    borderRadius: 9,
  },
  audioSkipBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: 14,
    backgroundColor: "#D1FAE5",
    gap: 2,
    minWidth: 36,
  },
  audioSkipBtnDisabled: {
    opacity: 0.5,
  },
  audioSkipLabel: {
    fontSize: 10,
    fontWeight: "700",
    color: colors.brand,
    fontVariant: ["tabular-nums"],
  },
  audioPreviewTime: {
    fontSize: fontSize.xs,
    fontVariant: ["tabular-nums"],
    color: colors.textSecondary,
    minWidth: 70,
    textAlign: "right",
  },
  noteControls: {
    marginTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
  },
  submitBtn: {
    backgroundColor: colors.brand,
    paddingVertical: spacing.lg,
    borderRadius: radius.lg,
    alignItems: "center",
  },
  submitBtnDisabled: { opacity: 0.5 },
  submitBtnText: { color: colors.textInverse, fontWeight: "700", fontSize: fontSize.md },
  viewNoteBtn: {
    backgroundColor: colors.brand,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    marginRight: spacing.sm,
  },
  newEncounterBtn: {
    backgroundColor: "#F3F4F6",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
  },
});
