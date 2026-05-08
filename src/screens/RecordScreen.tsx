/**
 * Record screen — audio capture with provider/patient/visit-type selection.
 * Mirrors the web Capture page. Supports offline queueing.
 */
import React, { useEffect, useState, useRef, useCallback } from "react";
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
} from "react-native";
import { Audio } from "expo-av";
import * as FileSystem from "expo-file-system/legacy";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import DateTimePicker, { DateTimePickerAndroid } from "@react-native-community/datetimepicker";
import * as DocumentPicker from "expo-document-picker";

import Card from "../components/Card";
import ProgressBar from "../components/ProgressBar";
import { colors, fontSize, spacing, radius } from "../lib/theme";
import {
  fetchProviders,
  fetchPatientsByProviderDate,
  createEncounter,
  resolveEncounterProviderId,
  uploadEncounterAudio,
  getWsUrl,
  type ProviderSummary,
  type PatientSearchResult,
} from "../lib/api";
import { useSettings, getApiKey, getApiUrl } from "../store/settings";
import { useOfflineStore } from "../store/offline";

const FRONTEND_PARITY_VISIT_TYPE = "follow_up";

const MODES = [
  { value: "dictation", label: "Dictation" },
  { value: "ambient", label: "Conversation" },
];

type PipelineStage = "idle" | "recording" | "creating" | "uploading" | "processing" | "complete" | "error";

function normalize(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function getPatientDisplayName(patient: Pick<PatientSearchResult, "first_name" | "last_name" | "mrn" | "id">): string {
  const fullName = `${patient.first_name || ""} ${patient.last_name || ""}`.trim();
  if (fullName) return fullName;
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
  const value = String(isoDate || "").trim();
  const [yearStr, monthStr, dayStr] = value.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  if (!year || !month || !day) return value || "N/A";
  return `${month}/${day}/${year}`;
}

function normalizeEncounterIdPart(value: unknown): string {
  return String(value ?? "")
    .trim()
    // Keep backend-identifying chars like "." and "-" from Eclipse IDs.
    // Only collapse whitespace to avoid unsafe URL spacing.
    .replace(/\s+/g, "");
}

function makeClientEncounterId(params: {
  patientCaseId: string;
  appointmentId: string;
  providerId: string;
  dateOfService: string;
}): string {
  const patientCasePart = normalizeEncounterIdPart(params.patientCaseId) || "unknown";
  const datePart = String(params.dateOfService || "").trim().replace(/-/g, "") || "unknown";
  let appointmentPart = normalizeEncounterIdPart(params.appointmentId) || "unknown";
  // If appointment id already includes date_of_service suffix, strip it to
  // avoid duplicate "..._{date}_{date}" encounter ids.
  if (appointmentPart.endsWith(`_${datePart}`)) {
    appointmentPart = appointmentPart.slice(0, -(`_${datePart}`.length));
  }
  const providerPart = normalizeEncounterIdPart(params.providerId) || "unknown";
  return `${patientCasePart}_${appointmentPart}_${providerPart}_${datePart}`;
}

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

export default function RecordScreen() {
  const nav = useNavigation<any>();
  const { width } = useWindowDimensions();
  const isTablet = width >= 768;

  // Data
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [providersLoaded, setProvidersLoaded] = useState(false);
  const [patients, setPatients] = useState<PatientSearchResult[]>([]);
  const [patientQuery, setPatientQuery] = useState("");
  const [appointmentDate, setAppointmentDate] = useState(getTodayDateIso());
  const [providerQuery, setProviderQuery] = useState("");
  const [providerLoadError, setProviderLoadError] = useState<string | null>(null);
  const [patientLoadError, setPatientLoadError] = useState<string | null>(null);
  const [patientsLoading, setPatientsLoading] = useState(false);

  // Selections
  const [providerId, setProviderId] = useState("");
  const [selectedPatient, setSelectedPatient] = useState<PatientSearchResult | null>(null);
  const [mode, setMode] = useState("dictation");

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
  const liveAsrFormatRef = useRef<"pcm" | "none">("pcm");

  // Pipeline
  const [stage, setStage] = useState<PipelineStage>("idle");
  const [progress, setProgress] = useState(0);
  const [statusMsg, setStatusMsg] = useState("");
  const [resultSampleId, setResultSampleId] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // Offline
  const { isOnline, enqueue, checkConnectivity } = useOfflineStore();

  // Re-fetch when the API URL changes (e.g. user saves cloudflare tunnel URL)
  const apiUrl = useSettings((s) => s.apiUrl);

  // Load providers
  useEffect(() => {
    setProviderLoadError(null);
    setProvidersLoaded(false);
    fetchProviders()
      .then((ps) => {
        const sortedProviders = [...ps].sort((a, b) =>
          normalize(a.name ?? a.id).localeCompare(normalize(b.name ?? b.id)),
        );
        setProviders(sortedProviders);
        if (sortedProviders.length > 0) {
          const currentExists = sortedProviders.some((p) => p.id === providerId);
          if (!providerId || !currentExists) {
            setProviderId(sortedProviders[0].id);
          }
        }
        setProvidersLoaded(true);
      })
      .catch((err) => {
        setProviderLoadError(err instanceof Error ? err.message : "Failed to load providers");
        setProvidersLoaded(true);
      });
  }, [apiUrl]);

  // Patient search — fetch once per provider/date, filter locally
  const [allPatients, setAllPatients] = useState<PatientSearchResult[]>([]);

  useEffect(() => {
    // Hit the network when provider/date changes.
    setSelectedPatient(null);
    setPatientQuery("");
    setPatients([]);
    setAllPatients([]);
    setPatientLoadError(null);
    setPatientsLoading(false);
    if (!providerId) {
      return;
    }
    setPatientsLoading(true);
    fetchPatientsByProviderDate(providerId, appointmentDate)
      .then((list) => {
        const sortedList = [...list].sort((a, b) =>
          normalize(`${a.last_name} ${a.first_name}`).localeCompare(normalize(`${b.last_name} ${b.first_name}`)),
        );
        setAllPatients(sortedList);
        setPatients(sortedList);
      })
      .catch((err) => {
        setPatientLoadError(err instanceof Error ? err.message : "Failed to load patients");
      })
      .finally(() => {
        setPatientsLoading(false);
      });
  }, [providerId, appointmentDate, apiUrl]);

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

  // Cleanup
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (noteTimerRef.current) clearInterval(noteTimerRef.current);
      wsRef.current?.close();
      if (asrReadIntervalRef.current) clearInterval(asrReadIntervalRef.current);
      asrWsRef.current?.close();
    };
  }, []);

  // ---- Recording ----
  const startRecording = async () => {
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
        setAsrError(null);
        setAsrStatus("Connected. Listening...");
        fetch(`${base}/asr/preload?mode=${encodeURIComponent(wsMode)}`, {
          method: "POST",
          headers: key ? { Authorization: `Bearer ${key}` } : {},
        }).catch(() => {});

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
              // WAV carries a 44-byte header; ASR format=pcm expects raw s16le data.
              const skip = Math.max(0, 44 - offset);
              if (skip >= bytes.byteLength) return;
              bytes = bytes.slice(skip);
              asrPcmHeaderSkippedRef.current = true;
            }
            if (bytes.byteLength > 0 && asrWsRef.current?.readyState === WebSocket.OPEN) {
              const payload = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
              asrWsRef.current.send(payload);
              asrReadOffsetRef.current = size;
              asrChunksSentRef.current += 1;
              setAsrStatus("Streaming audio...");
            }
          } catch {
            // Keep recording flow stable even if ASR chunk read fails.
          }
        }, 1200);

        setTimeout(() => {
          if (asrChunksSentRef.current === 0 && asrWsRef.current?.readyState === WebSocket.OPEN) {
            setAsrError("Live ASR connected but no audio chunks detected yet.");
          }
        }, 6000);
      };
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(String(event.data));
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
      ws.onerror = () => setAsrError("Live transcription connection error");
      ws.onclose = () => {
        setAsrStreaming(false);
        setAsrStatus("");
      };
    } catch {
      setAsrError("Unable to start live transcription");
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

    // Check connectivity
    const online = await checkConnectivity();
    if (!online) {
      await enqueue({
        provider_id: providerId,
        patient_id: selectedPatient.id,
          visit_type: FRONTEND_PARITY_VISIT_TYPE,
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
      const patientNameForRequest = `${selectedPatient.first_name || ""} ${selectedPatient.last_name || ""}`.trim();
      const appointmentId =
        String(selectedPatient.appointment_id || "").trim() ||
        String(selectedPatient.id || "").trim();
      const providerIdCandidate =
        String(selectedPatient.provider_source_id || "").trim() ||
        String(encounterProviderId || "").trim() ||
        String(providerId || "").trim();
      const providerIdForEncounter = providerIdCandidate.startsWith("name:")
        ? providerIdCandidate.replace(/^name:/, "")
        : providerIdCandidate;
      const clientEncounterId = makeClientEncounterId({
        patientCaseId,
        appointmentId,
        providerId: providerIdForEncounter,
        dateOfService: appointmentDate,
      });

      let enc;
      try {
        enc = await createEncounter({
          encounter_id: clientEncounterId,
          provider_id: encounterProviderId,
          patient_id: selectedPatient.id,
          patient_name: patientNameForRequest || undefined,
            visit_type: FRONTEND_PARITY_VISIT_TYPE,
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
              visit_type: FRONTEND_PARITY_VISIT_TYPE,
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
          ws.close();
        } else if (data.type === "error") {
          setStage("error");
          setStatusMsg(data.error ?? "Pipeline error");
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

      const result = await uploadEncounterAudio(
        effectiveEncounterId,
        recordingUri,
        audioFilename,
        effectiveNoteAudioUri,
        effectiveNoteAudioFilename,
      );

      setStage("processing");
      setStatusMsg(result.message ?? "Pipeline running...");
      setResultSampleId(result.sample_id);
      setProgress(10);
    } catch (err) {
      setStage("error");
      setStatusMsg(err instanceof Error ? err.message : "Unknown error");
    }
  }, [
    providerId,
    selectedPatient,
    recordingUri,
    mode,
    stage,
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
    setMode("dictation");
    setSelectedPatient(null);
    setPatientQuery("");
    discardRecording();
    wsRef.current?.close();
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
      contentContainerStyle={[styles.content, isTablet && styles.tabletContent]}
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

      {/* Provider */}
      <Card>
        <Text style={styles.label}>Provider</Text>
        {!providersLoaded ? (
          <Text style={styles.sublabel}>
            Loading providers...
          </Text>
        ) : providers.length === 0 ? (
          <Text style={styles.sublabel}>
            {providerLoadError ? `Unable to load providers: ${providerLoadError}` : "No providers found."}
          </Text>
        ) : (
          <>
            {providerId ? (
              <View style={styles.selectedProviderBanner}>
                <Ionicons name="checkmark-circle" size={16} color={colors.brand} />
                <Text style={styles.selectedProviderText}>
                  Selected: {providers.find((p) => p.id === providerId)?.name ?? providerId}
                </Text>
              </View>
            ) : null}
            <View style={styles.searchBox}>
              <Ionicons name="search" size={16} color={colors.textTertiary} />
              <TextInput
                value={providerQuery}
                onChangeText={setProviderQuery}
                placeholder="Search providers..."
                style={styles.searchInput}
                placeholderTextColor={colors.textTertiary}
              />
            </View>
            <Text style={styles.providerCountText}>
              Showing {filteredProviders.length} of {providers.length} providers
            </Text>
            <FlatList
              data={filteredProviders}
              keyExtractor={(p) => p.id}
              style={styles.providerList}
              horizontal
              nestedScrollEnabled
              keyboardShouldPersistTaps="handled"
              showsHorizontalScrollIndicator
              renderItem={({ item }) => {
                const isActive = providerId === item.id;
                return (
                  <TouchableOpacity
                    style={[styles.providerListRow, isActive && styles.providerListRowActive]}
                    onPress={() => setProviderId(item.id)}
                  >
                    <Text style={[styles.providerListName, isActive && styles.providerListNameActive]}>
                      {item.name ?? item.id}
                    </Text>
                  </TouchableOpacity>
                );
              }}
              ListEmptyComponent={
                <Text style={styles.sublabel}>No providers found.</Text>
              }
            />
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
                <Text style={styles.datePickerText}>{appointmentDate}</Text>
                <Ionicons name="chevron-down" size={16} color={colors.textTertiary} />
              </TouchableOpacity>
            )}
          </>
        )}
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
                MRN: {selectedPatient.mrn} · DOB: {selectedPatient.date_of_birth}
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
            {patientsLoading && (
              <View style={styles.patientLoadingRow}>
                <ActivityIndicator size="small" color={colors.brand} />
                <Text style={styles.patientLoadingText}>Loading patients for selected provider...</Text>
              </View>
            )}
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
                    MRN: {item.mrn} · {item.sex} · {item.date_of_birth}
                  </Text>
                </TouchableOpacity>
              )}
              ListEmptyComponent={
                <Text style={styles.sublabel}>
                  {patientsLoading
                    ? "Loading patients..."
                    : patientLoadError
                    ? `Unable to load patients: ${patientLoadError}`
                    : "No patients found. Try adjusting your search."}
                </Text>
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
            <Text style={styles.detailLabel}>Location: </Text>
            {"Pennsylvania"}
          </Text>
          <Text style={styles.detailLine}>
            <Text style={styles.detailLabel}>Name: </Text>
            {selectedPatient ? getPatientDisplayName(selectedPatient) : "Not selected"}
          </Text>
          <Text style={styles.detailLine}>
            <Text style={styles.detailLabel}>Provider: </Text>
            {(providers.find((p) => p.id === providerId)?.name ?? providerId) || "N/A"}
          </Text>
          <Text style={styles.detailLine}>
            <Text style={styles.detailLabel}>Date of Birth: </Text>
            {selectedPatient?.date_of_birth || "N/A"}
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
              <TouchableOpacity
                style={[styles.recordBtn, stage === "recording" && styles.recordBtnActive]}
                onPress={stage === "recording" ? stopRecording : startRecording}
                disabled={stage !== "idle" && stage !== "recording"}
              >
                <Ionicons
                  name={stage === "recording" ? "stop" : "mic"}
                  size={32}
                  color={colors.textInverse}
                />
              </TouchableOpacity>
              <View style={{ marginTop: spacing.sm }}>
                {stage === "recording" ? (
                  <>
                    <View style={styles.row}>
                      <View style={styles.pulseDot} />
                      <Text style={[styles.recordingLabel, { color: colors.error }]}>Recording...</Text>
                    </View>
                    <Text style={styles.timer}>{formatTime(duration)}</Text>
                  </>
                ) : (
                  <Text style={styles.tapToRecord}>Tap to start recording</Text>
                )}
              </View>
            </View>
            <View style={{ marginLeft: spacing.md }}>
              <TouchableOpacity
                style={styles.uploadBtn}
                onPress={pickAudioFile}
                disabled={stage === "recording"}
              >
                <Ionicons name="cloud-upload-outline" size={16} color={colors.text} />
                <Text style={styles.uploadBtnText}>Upload Audio</Text>
              </TouchableOpacity>
              <Text style={styles.uploadHint}>Use an existing audio file</Text>
            </View>
          </View>
        ) : (
          <View style={styles.recordedRow}>
            <Ionicons name="document-text" size={22} color={colors.brand} />
            <View style={{ flex: 1, marginLeft: spacing.sm }}>
              <Text style={{ fontSize: fontSize.sm, fontWeight: "600", color: colors.text }}>
                Audio ready{duration > 0 ? ` (${formatTime(duration)})` : ""}
              </Text>
              <Text style={{ fontSize: fontSize.xs, color: colors.textSecondary, marginTop: 2 }}>{audioFilename}</Text>
              {mode === "ambient" && noteAudioUri ? (
                <Text style={{ fontSize: fontSize.xs, color: colors.textSecondary, marginTop: 2 }}>
                  Notes audio: {noteAudioFilename}
                </Text>
              ) : null}
            </View>
            <TouchableOpacity onPress={discardRecording}>
              <Ionicons name="close-circle" size={22} color={colors.textTertiary} />
            </TouchableOpacity>
          </View>
        )}
        {mode === "ambient" && recordingUri ? (
          <View style={styles.noteControls}>
            <Text style={styles.sublabel}>Conversation Notes</Text>
            {noteRecording ? (
              <>
                <View style={styles.row}>
                  <View style={styles.pulseDot} />
                  <Text style={[styles.recordingLabel, { color: colors.error }]}>
                    Recording notes... {formatTime(noteDuration)}
                  </Text>
                </View>
                <View style={[styles.row, { marginTop: spacing.sm }]}>
                  <TouchableOpacity style={styles.uploadBtn} onPress={stopNoteRecording}>
                    <Ionicons name="stop" size={16} color={colors.text} />
                    <Text style={styles.uploadBtnText}>Stop Notes</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.uploadBtn, { marginLeft: spacing.sm }]} onPress={clearNoteAudio}>
                    <Ionicons name="trash-outline" size={16} color={colors.text} />
                    <Text style={styles.uploadBtnText}>Discard</Text>
                  </TouchableOpacity>
                </View>
              </>
            ) : noteAudioUri ? (
              <>
                <Text style={{ fontSize: fontSize.xs, color: colors.textSecondary }}>
                  Notes audio ready: {noteAudioFilename}
                </Text>
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
        {(asrStreaming || asrPartialText || asrFinalSegments.length > 0 || asrError) && (
          <View style={{ marginTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.sm }}>
            <Text style={styles.sublabel}>Live Transcript</Text>
            {asrError ? <Text style={{ color: colors.error, fontSize: fontSize.xs }}>{asrError}</Text> : null}
            {!asrError && asrStatus ? (
              <Text style={{ color: colors.textSecondary, fontSize: fontSize.xs }}>{asrStatus}</Text>
            ) : null}
            {asrPartialText ? (
              <Text style={{ color: colors.textSecondary, fontSize: fontSize.xs }}>{asrPartialText}</Text>
            ) : null}
            {asrFinalSegments.slice(-3).map((seg, idx) => (
              <Text key={`${idx}-${seg.slice(0, 10)}`} style={{ color: colors.text, fontSize: fontSize.xs, marginTop: 2 }}>
                {seg}
              </Text>
            ))}
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
            color={stage === "error" ? colors.error : stage === "complete" ? colors.brand : colors.indigo}
          />
          <View style={[styles.row, { marginTop: spacing.md }]}>
            {(stage === "creating" || stage === "uploading" || stage === "processing") && (
              <ActivityIndicator size="small" color={colors.indigo} style={{ marginRight: spacing.sm }} />
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
  title: { fontSize: fontSize.xxl, fontWeight: "700", color: colors.text },
  subtitle: { fontSize: fontSize.sm, color: colors.textSecondary, marginBottom: spacing.sm },
  label: { fontSize: fontSize.sm, fontWeight: "600", color: colors.text },
  sublabel: { fontSize: fontSize.xs, fontWeight: "500", color: colors.textSecondary, marginBottom: spacing.xs },
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
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: "#86EFAC",
    backgroundColor: "#ECFDF5",
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  selectedProviderText: {
    color: colors.brand,
    fontSize: fontSize.xs,
    fontWeight: "600",
    flex: 1,
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
