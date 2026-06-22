/**
 * Component tests for the mobile Visit Type selector on RecordScreen.
 *
 * Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 6.1, 6.2, 10.2, 10.4
 *
 * Covers three groups (feature: recording-visit-type-selector):
 *  - The visit-type row renders the three options (Initial / Follow-Up /
 *    Discharge) with the correct label→value mapping, and selection updates
 *    when a provider taps an option (4.1–4.5).
 *  - `handleSubmit` forwards the PROVIDER-SELECTED visit type to
 *    `createEncounter` (and onto the uploaded EncounterDemographics) rather
 *    than the legacy `resolveVisitType` auto-derivation when they differ
 *    (6.2); `buildEncounterDetails` sets `visit_type` when provided (6.1).
 *  - The selector is disabled once recording locks the screen
 *    (`stage !== "idle"`) and enabled while idle (10.2, 10.4).
 */
import React from "react";
import { Alert } from "react-native";
import { render, fireEvent, waitFor, screen } from "@testing-library/react-native";

import {
  buildEncounterDetails,
  VISIT_TYPES,
  resolveVisitType,
  type PatientSearchResult,
} from "../../lib/api";

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

// `new_repeat_patient: "Repeat"` → deriveDefaultVisitType → "follow_up", and
// resolveVisitType(...) can only ever yield "default"/"initial_evaluation"/
// "follow_up" — never "discharge". So if the provider picks "Discharge" and
// createEncounter receives "discharge", it definitively used the explicit
// selection rather than the auto-derivation.
const TEST_PATIENT: PatientSearchResult = {
  id: "pat-1",
  first_name: "Jane",
  last_name: "Doe",
  date_of_birth: "1980-01-01",
  sex: "F",
  mrn: "MRN123",
  practice_id: "Eclipse",
  new_repeat_patient: "Repeat",
  appointment_id: "appt-1",
  // No appointment_at → the today-schedule auto-select never fires, so the
  // test deterministically selects the patient by tapping the row.
};

// ---------------------------------------------------------------------------
// Mocked network surface of lib/api (real pure helpers are preserved)
// ---------------------------------------------------------------------------

const mockCreateEncounter = jest.fn(() =>
  Promise.resolve({
    encounter_id: "enc-1",
    status: "created",
    provider_id: "prov-1",
    patient_id: "pat-1",
    visit_type: "follow_up",
    mode: "dictation",
    message: null,
  }),
);
const mockUploadEncounterAudio = jest.fn(() =>
  Promise.resolve({
    encounter_id: "enc-1",
    sample_id: "samp-1",
    status: "ok",
    message: "Pipeline running",
  }),
);
const mockFetchPatientsByProviderDate = jest.fn(() => Promise.resolve([TEST_PATIENT]));
const mockResolveEncounterProviderId = jest.fn(() => Promise.resolve("prov-1"));
const mockFetchEncounterStatus = jest.fn(() => Promise.resolve({ status: "processing" }));

jest.mock("../../lib/api", () => {
  const actual = jest.requireActual("../../lib/api");
  return {
    ...actual,
    fetchPatientsByProviderDate: (...args: any[]) => mockFetchPatientsByProviderDate(...args),
    createEncounter: (...args: any[]) => mockCreateEncounter(...args),
    resolveEncounterProviderId: (...args: any[]) => mockResolveEncounterProviderId(...args),
    uploadEncounterAudio: (...args: any[]) => mockUploadEncounterAudio(...args),
    fetchEncounterStatus: (...args: any[]) => mockFetchEncounterStatus(...args),
    getWsUrl: () => "ws://localhost:8100",
  };
});

// ---------------------------------------------------------------------------
// Store mocks — deterministic provider/patient/online state
// ---------------------------------------------------------------------------

const mockProvidersState = {
  providers: [
    {
      id: "prov-1",
      name: "Dr. Smith",
      credentials: null,
      specialty: null,
      latest_score: null,
      quality_scores: {},
    },
  ],
  loadedLocation: "pennsylvania",
  loadedAt: Date.now(),
  loading: false,
  error: null,
  hydrated: true,
  loadProviders: jest.fn(() => Promise.resolve()),
  hydrateFromCache: jest.fn(() => Promise.resolve()),
};
jest.mock("../../store/providers", () => ({
  useProviders: (selector: any) => selector(mockProvidersState),
}));

const mockSettingsState = {
  apiUrl: "http://localhost:8100",
  apiKey: "",
  eclipseLocation: "pennsylvania",
  loaded: true,
  configured: true,
  setApiUrl: jest.fn(),
  setApiKey: jest.fn(),
  setEclipseLocation: jest.fn(),
};
jest.mock("../../store/settings", () => ({
  useSettings: (selector: any) => selector(mockSettingsState),
  getApiUrl: () => "http://localhost:8100",
  getApiKey: () => "",
  getEclipseLocation: () => "pennsylvania",
}));

const mockOfflineState = {
  queue: [],
  isOnline: true,
  enqueue: jest.fn(() => Promise.resolve()),
  remove: jest.fn(),
  processQueue: jest.fn(() => Promise.resolve()),
  checkConnectivity: jest.fn(() => Promise.resolve(true)),
  load: jest.fn(() => Promise.resolve()),
};
jest.mock("../../store/offline", () => ({
  useOfflineStore: () => mockOfflineState,
}));

const mockAuthState = {
  isAuthenticated: true,
  user: { name: "Dr. Smith", email: "smith@example.com", method: "biometric" },
  accessToken: null,
  loading: false,
  isRestoredSession: false,
};
jest.mock("../../store/auth", () => ({
  useAuthStore: (selector: any) => selector(mockAuthState),
}));

jest.mock("../../store/patientsCache", () => ({
  getCachedPatients: jest.fn(() => Promise.resolve({ status: "miss" })),
  setCachedPatients: jest.fn(),
  peekCachedPatients: jest.fn(() => null),
}));

jest.mock("../../lib/providerMatch", () => ({
  findProviderForUser: () => "prov-1",
  tokensFromName: () => [],
}));

// ---------------------------------------------------------------------------
// Native / Expo module mocks
// ---------------------------------------------------------------------------

jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn(), addListener: jest.fn() }),
}));

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: any) => children,
}));

jest.mock("@react-native-community/datetimepicker", () => {
  const React = require("react");
  const { View } = require("react-native");
  const DateTimePicker = (props: any) => React.createElement(View, props);
  return {
    __esModule: true,
    default: DateTimePicker,
    DateTimePickerAndroid: { open: jest.fn() },
  };
});

jest.mock("expo-document-picker", () => ({
  getDocumentAsync: jest.fn(() =>
    Promise.resolve({
      canceled: false,
      assets: [{ uri: "file:///audio.m4a", name: "audio.m4a" }],
    }),
  ),
}));

jest.mock("expo-file-system/legacy", () => ({
  getInfoAsync: jest.fn(() => Promise.resolve({ exists: true, size: 1024 })),
  readAsStringAsync: jest.fn(() => Promise.resolve("")),
  writeAsStringAsync: jest.fn(() => Promise.resolve()),
  deleteAsync: jest.fn(() => Promise.resolve()),
  EncodingType: { Base64: "base64", UTF8: "utf8" },
}));

jest.mock("expo-av", () => {
  const makeSound = () => ({
    setOnPlaybackStatusUpdate: jest.fn(),
    unloadAsync: jest.fn(() => Promise.resolve()),
    playAsync: jest.fn(() => Promise.resolve()),
    pauseAsync: jest.fn(() => Promise.resolve()),
    setPositionAsync: jest.fn(() => Promise.resolve()),
  });
  return {
    Audio: {
      Sound: {
        createAsync: jest.fn(() => Promise.resolve({ sound: makeSound() })),
      },
      Recording: { createAsync: jest.fn() },
      requestPermissionsAsync: jest.fn(() => Promise.resolve({ granted: true, status: "granted" })),
      getPermissionsAsync: jest.fn(() => Promise.resolve({ granted: true, status: "granted" })),
      setAudioModeAsync: jest.fn(() => Promise.resolve()),
      RecordingOptionsPresets: { HIGH_QUALITY: {} },
      INTERRUPTION_MODE_IOS_DO_NOT_MIX: 1,
      INTERRUPTION_MODE_ANDROID_DO_NOT_MIX: 1,
    },
  };
});

// WebSocket is constructed in handleSubmit for live progress; provide a no-op.
class MockWebSocket {
  onmessage: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  onopen: ((event: any) => void) | null = null;
  onclose: ((event: any) => void) | null = null;
  close() {}
  send() {}
}
(global as any).WebSocket = MockWebSocket as any;

import RecordScreen from "../RecordScreen";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Walk up from the option's label Text to the TouchableOpacity host element
 * carrying `accessibilityState` ({ selected, disabled }).
 */
function getCardState(label: string): { selected?: boolean; disabled?: boolean } | undefined {
  let node: any = screen.getByText(label);
  while (node && !node.props?.accessibilityState) {
    node = node.parent;
  }
  return node?.props?.accessibilityState;
}

async function selectTestPatient() {
  // Patient row appears once the (mocked) fetch resolves.
  const row = await screen.findByText("Doe, Jane");
  fireEvent.press(row);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFetchPatientsByProviderDate.mockResolvedValue([TEST_PATIENT] as any);
  mockResolveEncounterProviderId.mockResolvedValue("prov-1" as any);
  mockCreateEncounter.mockResolvedValue({
    encounter_id: "enc-1",
    status: "created",
    provider_id: "prov-1",
    patient_id: "pat-1",
    visit_type: "follow_up",
    mode: "dictation",
    message: null,
  } as any);
  mockUploadEncounterAudio.mockResolvedValue({
    encounter_id: "enc-1",
    sample_id: "samp-1",
    status: "ok",
    message: "Pipeline running",
  } as any);
  mockFetchEncounterStatus.mockResolvedValue({ status: "processing" } as any);
  // Auto-confirm any Alert (e.g. the dev demographics preview) by pressing the
  // last actionable button so the submit flow proceeds to upload.
  jest.spyOn(Alert, "alert").mockImplementation((_title, _message, buttons) => {
    if (Array.isArray(buttons) && buttons.length > 0) {
      const last: any = buttons[buttons.length - 1];
      last?.onPress?.();
    }
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// buildEncounterDetails — visit_type (Requirement 6.1)
// ---------------------------------------------------------------------------

describe("buildEncounterDetails — visit_type (Req 6.1)", () => {
  it("sets visit_type on the demographics payload when provided", () => {
    const result = buildEncounterDetails({
      providerName: "Dr. Smith",
      patientName: "Doe, Jane",
      patientDob: "1980-01-01",
      visitType: "discharge",
    });
    expect(result.visit_type).toBe("discharge");
  });

  it("omits visit_type when not provided (backward compatible)", () => {
    const result = buildEncounterDetails({
      providerName: "Dr. Smith",
      patientName: "Doe, Jane",
      patientDob: "1980-01-01",
    });
    expect(result).not.toHaveProperty("visit_type");
  });
});

// ---------------------------------------------------------------------------
// VISIT_TYPES option mapping (Requirements 4.1–4.4)
// ---------------------------------------------------------------------------

describe("VISIT_TYPES label→value mapping (Req 4.1–4.4)", () => {
  it("defines exactly three options mapping each label to its routing key", () => {
    expect(VISIT_TYPES).toEqual([
      { value: "initial_evaluation", label: "Initial" },
      { value: "follow_up", label: "Follow-Up" },
      { value: "discharge", label: "Discharge" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// RecordScreen — visit type selector rendering / selection / lock state
// ---------------------------------------------------------------------------

describe("RecordScreen — Visit Type selector", () => {
  it("renders the three visit-type options and keeps them enabled while idle (Req 4.1, 10.4)", async () => {
    render(<RecordScreen />);

    // All three labels render.
    expect(await screen.findByText("Initial")).toBeTruthy();
    expect(screen.getByText("Follow-Up")).toBeTruthy();
    expect(screen.getByText("Discharge")).toBeTruthy();

    // While idle (stage === "idle") every option is enabled for selection.
    expect(getCardState("Initial")?.disabled).toBe(false);
    expect(getCardState("Follow-Up")?.disabled).toBe(false);
    expect(getCardState("Discharge")?.disabled).toBe(false);

    // Default (derived from new_repeat_patient) is never "discharge".
    expect(getCardState("Discharge")?.selected).toBe(false);
  });

  it("updates the selection when the provider taps each option (Req 4.2–4.5)", async () => {
    render(<RecordScreen />);
    await selectTestPatient();

    // Default seed from "Repeat" → follow_up is selected.
    await waitFor(() => expect(getCardState("Follow-Up")?.selected).toBe(true));

    fireEvent.press(screen.getByText("Initial"));
    await waitFor(() => expect(getCardState("Initial")?.selected).toBe(true));
    expect(getCardState("Follow-Up")?.selected).toBe(false);
    expect(getCardState("Discharge")?.selected).toBe(false);

    fireEvent.press(screen.getByText("Discharge"));
    await waitFor(() => expect(getCardState("Discharge")?.selected).toBe(true));
    expect(getCardState("Initial")?.selected).toBe(false);
    expect(getCardState("Follow-Up")?.selected).toBe(false);

    fireEvent.press(screen.getByText("Follow-Up"));
    await waitFor(() => expect(getCardState("Follow-Up")?.selected).toBe(true));
    expect(getCardState("Discharge")?.selected).toBe(false);
  });

  it("submits the provider-selected visit type to createEncounter (not resolveVisitType) and locks the selector (Req 6.2, 10.2)", async () => {
    render(<RecordScreen />);
    await selectTestPatient();

    // Provider overrides the default to "Discharge" — a value resolveVisitType
    // can never produce.
    fireEvent.press(screen.getByText("Discharge"));
    await waitFor(() => expect(getCardState("Discharge")?.selected).toBe(true));

    // Use dictation mode so submit doesn't prompt for conversation notes.
    fireEvent.press(screen.getByText("Dictation"));

    // Provide audio via the file picker (sets recordingUri, stage stays idle).
    fireEvent.press(screen.getByText("Upload Audio"));

    // Submit button only renders once provider + patient + audio are ready.
    const submitBtn = await screen.findByText("Submit Dictation");
    fireEvent.press(submitBtn);

    // createEncounter receives the explicit provider selection.
    await waitFor(() => expect(mockCreateEncounter).toHaveBeenCalled());
    const createArg: any = mockCreateEncounter.mock.calls[0][0];
    expect(createArg.visit_type).toBe("discharge");

    // The auto-derivation would have produced something else entirely.
    const autoDerived = resolveVisitType(
      "pennsylvania",
      TEST_PATIENT.appointment_class,
      TEST_PATIENT.new_repeat_patient,
    );
    expect(autoDerived).not.toBe("discharge");
    expect(createArg.visit_type).not.toBe(autoDerived);

    // The same explicit value rides along on the uploaded demographics.
    await waitFor(() => expect(mockUploadEncounterAudio).toHaveBeenCalled());
    const demographics: any = mockUploadEncounterAudio.mock.calls[0][5];
    expect(demographics.visit_type).toBe("discharge");

    // Once submission moves the screen out of "idle", the selector locks.
    await waitFor(() => expect(getCardState("Discharge")?.disabled).toBe(true));
  });
});
