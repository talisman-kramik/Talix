/**
 * Smart Edit lifecycle hook — state machine for one amend session.
 *
 * Mirrors `MainAIScribe/src/ai_scribe_frontend/composables/useAmendLifecycle.js`
 * so behaviour stays identical to the web app. Phases:
 *
 *   idle ──submit──▶ loading ──response──▶ diff_preview ──acceptClick──▶ confirming
 *     ▲                │                        │                          │
 *     │             error                    reject                    confirmAccept
 *     │                │                        │                          │
 *     └────────────────┴────────────────────────┴──────────────────────────┘
 */
import { useCallback, useEffect, useRef, useState } from "react";

import {
  submitTextAmend,
  submitVoiceAmend,
  type AmendDiffChunk,
  type AmendResponse,
} from "../lib/amendService";

export type AmendPhase =
  | "idle"
  | "loading"
  | "diff_preview"
  | "confirming"
  | "error";

export type SubmittedVia = "text" | "voice";

export interface VoiceClip {
  uri: string;
  name?: string;
  mimeType?: string;
}

export interface SubmitArgs {
  encounterId: string;
  textInstruction?: string;
  audio?: VoiceClip | null;
  /** Note version to amend — null means latest. */
  version?: string | null;
  providerId?: string | null;
  baseNote?: string | null;
}

export interface ConfirmAcceptPayload {
  amendedNote: string;
  newVersion: string;
}

export interface AmendLifecycle {
  phase: AmendPhase;
  elapsedSeconds: number;
  errorMessage: string;
  diffResult: AmendDiffChunk[] | null;
  amendedNote: string | null;
  newVersion: string | null;
  submittedInput: string;
  submittedVia: SubmittedVia;

  submit: (args: SubmitArgs) => Promise<void>;
  cancel: () => void;
  retry: () => void;
  /** Return to the input view, preserving the last typed instruction. */
  revise: () => void;
  /** First click on Accept — opens the confirmation overlay. */
  acceptClick: () => void;
  /** Second click — returns the payload the screen needs to apply locally. */
  confirmAccept: () => ConfirmAcceptPayload | null;
  /** Back out of the confirmation overlay to the diff preview. */
  cancelConfirm: () => void;
  reject: () => void;
  resetAll: () => void;
}

interface InternalSubmit {
  encounterId: string;
  textInstruction: string;
  audio: VoiceClip | null;
  version: string | null;
  providerId: string | null;
  baseNote: string | null;
}

export function useAmendLifecycle(): AmendLifecycle {
  const [phase, setPhase] = useState<AmendPhase>("idle");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [errorMessage, setErrorMessage] = useState("");
  const [diffResult, setDiffResult] = useState<AmendDiffChunk[] | null>(null);
  const [amendedNote, setAmendedNote] = useState<string | null>(null);
  const [newVersion, setNewVersion] = useState<string | null>(null);
  const [submittedInput, setSubmittedInput] = useState("");
  const [submittedVia, setSubmittedVia] = useState<SubmittedVia>("text");

  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastSubmitRef = useRef<InternalSubmit | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const startTimer = useCallback(() => {
    setElapsedSeconds(0);
    clearTimer();
    timerRef.current = setInterval(() => {
      setElapsedSeconds((s) => s + 1);
    }, 1000);
  }, [clearTimer]);

  const runSubmit = useCallback(
    async (args: InternalSubmit) => {
      lastSubmitRef.current = args;

      // Best-effort abort of any prior in-flight request before starting.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      if (args.audio) {
        setSubmittedInput(args.textInstruction || "Voice recording");
        setSubmittedVia("voice");
      } else {
        setSubmittedInput(args.textInstruction);
        setSubmittedVia("text");
      }

      setPhase("loading");
      setErrorMessage("");
      startTimer();

      try {
        let response: AmendResponse;
        if (args.audio) {
          response = await submitVoiceAmend(args.encounterId, args.audio, {
            version: args.version,
            providerId: args.providerId,
            baseNote: args.baseNote,
            signal: controller.signal,
          });
        } else {
          response = await submitTextAmend(
            args.encounterId,
            args.textInstruction,
            {
              version: args.version,
              providerId: args.providerId,
              baseNote: args.baseNote,
              signal: controller.signal,
            },
          );
        }

        clearTimer();
        setDiffResult(response.diff);
        setAmendedNote(response.amended_note);
        setNewVersion(response.new_version);
        setPhase("diff_preview");
      } catch (err) {
        clearTimer();
        const name = (err as { name?: string } | null)?.name;
        if (name === "AbortError") {
          setPhase("idle");
          return;
        }
        const message =
          (err instanceof Error && err.message) ||
          "Connection failed. Please check your network and try again.";
        setErrorMessage(message);
        setPhase("error");
      }
    },
    [clearTimer, startTimer],
  );

  const submit = useCallback(
    async (args: SubmitArgs) => {
      const internal: InternalSubmit = {
        encounterId: args.encounterId,
        textInstruction: (args.textInstruction ?? "").trim(),
        audio: args.audio ?? null,
        version: args.version ?? null,
        providerId: args.providerId ?? null,
        baseNote: args.baseNote ?? null,
      };
      if (!internal.audio && !internal.textInstruction) {
        setErrorMessage("Please record audio or enter text instructions.");
        setPhase("error");
        return;
      }
      await runSubmit(internal);
    },
    [runSubmit],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    clearTimer();
    setPhase("idle");
  }, [clearTimer]);

  const retry = useCallback(() => {
    const last = lastSubmitRef.current;
    if (!last) return;
    setErrorMessage("");
    void runSubmit(last);
  }, [runSubmit]);

  const revise = useCallback(() => {
    setPhase("idle");
    setDiffResult(null);
    setAmendedNote(null);
    setNewVersion(null);
    // Keep submittedInput so the input bar can pre-fill the text field.
  }, []);

  const acceptClick = useCallback(() => {
    setPhase("confirming");
  }, []);

  const confirmAccept = useCallback((): ConfirmAcceptPayload | null => {
    if (amendedNote === null || newVersion === null) return null;
    const payload: ConfirmAcceptPayload = {
      amendedNote,
      newVersion,
    };
    // Reset everything after handing the payload back to the screen.
    abortRef.current?.abort();
    clearTimer();
    setPhase("idle");
    setElapsedSeconds(0);
    setErrorMessage("");
    setDiffResult(null);
    setAmendedNote(null);
    setNewVersion(null);
    setSubmittedInput("");
    setSubmittedVia("text");
    abortRef.current = null;
    lastSubmitRef.current = null;
    return payload;
  }, [amendedNote, newVersion, clearTimer]);

  const cancelConfirm = useCallback(() => {
    setPhase("diff_preview");
  }, []);

  const reject = useCallback(() => {
    setPhase("idle");
    setDiffResult(null);
    setAmendedNote(null);
    setNewVersion(null);
    setSubmittedInput("");
    setSubmittedVia("text");
  }, []);

  const resetAll = useCallback(() => {
    abortRef.current?.abort();
    clearTimer();
    setPhase("idle");
    setElapsedSeconds(0);
    setErrorMessage("");
    setDiffResult(null);
    setAmendedNote(null);
    setNewVersion(null);
    setSubmittedInput("");
    setSubmittedVia("text");
    abortRef.current = null;
    lastSubmitRef.current = null;
  }, [clearTimer]);

  // Clean up the timer + any in-flight request on unmount.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  return {
    phase,
    elapsedSeconds,
    errorMessage,
    diffResult,
    amendedNote,
    newVersion,
    submittedInput,
    submittedVia,

    submit,
    cancel,
    retry,
    revise,
    acceptClick,
    confirmAccept,
    cancelConfirm,
    reject,
    resetAll,
  };
}
