/**
 * Unit tests for the unified data source (canonical Pipeline_Server feed).
 *
 * Covers:
 *  - Enabled path: fetchProviders + the patient fetch call the canonical
 *    endpoints (/providers, /appointments) and map correctly.
 *  - canonicalAppointmentToPatient carries encounter_id and maps key fields;
 *    cancelled records (is_active=false) map to an excluded status.
 *  - Disabled path: the canonical endpoints are NOT called (Eclipse path used).
 */

// Mock the settings module so we can flip the unified-sync flag per test.
jest.mock("../../store/settings", () => ({
  getApiUrl: () => "http://localhost:8100",
  getApiKey: () => "test-key",
  isUnifiedSyncEnabled: jest.fn(),
}));

import {
  fetchProviders,
  fetchPatientsByProviderDate,
  canonicalAppointmentToPatient,
  canonicalProviderToSummary,
  isExcludedAppointmentStatus,
  type CanonicalAppointment,
} from "../api";
import { isUnifiedSyncEnabled } from "../../store/settings";

const mockedIsUnifiedSyncEnabled = isUnifiedSyncEnabled as jest.Mock;

function jsonResponse(data: unknown): Partial<Response> {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(""),
  };
}

function baseAppointment(overrides: Partial<CanonicalAppointment> = {}): CanonicalAppointment {
  return {
    encounter_id: "enc-123",
    system_location: "pennsylvania",
    is_active: true,
    source_system: "Eclipse",
    source_appointment_id: "44290913",
    source_encounter_id: "src-enc-1",
    provider_id: "Excelsia.28.1",
    provider_name: "Scott Pello",
    patient_name: "ALFARO, ELSY",
    first_name: "ELSY",
    last_name: "ALFARO",
    account_number: "10200.2.Excelsia",
    case_name: "MD (WC010214)",
    case_number: "WC010214",
    guarantor_id: "G-1",
    date_of_birth: "1964-06-27",
    appointment_date: "2026-06-03",
    appointment_class: "follow_up",
    location_name: "West Philadelphia",
    injury_date: "2025-05-21",
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-01T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  (global.fetch as jest.Mock).mockReset();
  mockedIsUnifiedSyncEnabled.mockReset();
});

// ---------------------------------------------------------------------------
// canonicalAppointmentToPatient
// ---------------------------------------------------------------------------

describe("canonicalAppointmentToPatient", () => {
  it("carries the server-provided encounter_id and maps key fields", () => {
    const patient = canonicalAppointmentToPatient(baseAppointment());

    expect(patient.encounter_id).toBe("enc-123");
    expect(patient.first_name).toBe("ELSY");
    expect(patient.last_name).toBe("ALFARO");
    expect(patient.date_of_birth).toBe("1964-06-27");
    expect(patient.mrn).toBe("10200.2.Excelsia");
    expect(patient.practice_id).toBe("pennsylvania");
    expect(patient.appointment_class).toBe("follow_up");
    expect(patient.case_name).toBe("MD (WC010214)");
    expect(patient.case_number).toBe("WC010214");
    expect(patient.appointment_id).toBe("44290913");
    expect(patient.provider_name).toBe("Scott Pello");
  });

  it("leaves active appointments without an excluded status", () => {
    const patient = canonicalAppointmentToPatient(baseAppointment({ is_active: true }));
    expect(isExcludedAppointmentStatus(patient.appointment_status)).toBe(false);
  });

  it("maps cancelled (is_active=false) records to an excluded status", () => {
    const patient = canonicalAppointmentToPatient(baseAppointment({ is_active: false }));
    expect(patient.appointment_status).toBe("Cancelled");
    expect(isExcludedAppointmentStatus(patient.appointment_status)).toBe(true);
  });
});

describe("canonicalProviderToSummary", () => {
  it("maps provider_id/provider_name onto the ProviderSummary shape", () => {
    const summary = canonicalProviderToSummary({
      provider_id: "Excelsia.28.1",
      provider_name: "Scott Pello",
    });
    expect(summary.id).toBe("Excelsia.28.1");
    expect(summary.name).toBe("Scott Pello");
    expect(summary.credentials).toBeNull();
    expect(summary.specialty).toBeNull();
    expect(summary.latest_score).toBeNull();
    expect(summary.quality_scores).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Enabled path: canonical endpoints are called and mapped
// ---------------------------------------------------------------------------

describe("unified-sync ENABLED path", () => {
  beforeEach(() => {
    mockedIsUnifiedSyncEnabled.mockReturnValue(true);
  });

  it("fetchProviders calls /providers?location= and maps the response", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      jsonResponse([
        { provider_id: "Excelsia.28.1", provider_name: "Scott Pello" },
        { provider_id: "Excelsia.7.2", provider_name: "Adel Kebaish" },
      ]),
    );

    const providers = await fetchProviders("pennsylvania");

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url).toContain("/providers?location=pennsylvania");

    // Sorted alphabetically by name (Adel before Scott).
    expect(providers.map((p) => p.name)).toEqual(["Adel Kebaish", "Scott Pello"]);
    expect(providers[0].id).toBe("Excelsia.7.2");
  });

  it("fetchPatientsByProviderDate calls /appointments and maps + carries encounter_id", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      jsonResponse([baseAppointment()]),
    );

    const patients = await fetchPatientsByProviderDate(
      "Excelsia.28.1",
      "2026-06-03",
      "",
      "pennsylvania",
    );

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url).toContain("/appointments?location=pennsylvania");
    expect(url).toContain("provider_id=Excelsia.28.1");
    expect(url).toContain("date=2026-06-03");

    expect(patients).toHaveLength(1);
    expect(patients[0].encounter_id).toBe("enc-123");
    expect(patients[0].last_name).toBe("ALFARO");
  });

  it("filters out cancelled (is_active=false) appointments downstream", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      jsonResponse([
        baseAppointment({ encounter_id: "active-1", is_active: true }),
        baseAppointment({
          encounter_id: "cancelled-1",
          is_active: false,
          source_appointment_id: "99999",
          account_number: "99999.0",
          first_name: "JANE",
          last_name: "DOE",
        }),
      ]),
    );

    const patients = await fetchPatientsByProviderDate(
      "Excelsia.28.1",
      "2026-06-03",
      "",
      "pennsylvania",
    );

    expect(patients).toHaveLength(1);
    expect(patients[0].encounter_id).toBe("active-1");
  });
});

// ---------------------------------------------------------------------------
// Disabled path: canonical endpoints are NOT called
// ---------------------------------------------------------------------------

describe("unified-sync DISABLED path", () => {
  beforeEach(() => {
    mockedIsUnifiedSyncEnabled.mockReturnValue(false);
  });

  it("fetchProviders does not call the canonical /providers endpoint", async () => {
    // Eclipse config is unset in the test env, so the Eclipse path throws
    // before any canonical fetch. The key assertion is that /providers is never hit.
    await expect(fetchProviders("pennsylvania")).rejects.toThrow();

    const canonicalCalls = (global.fetch as jest.Mock).mock.calls.filter((call) =>
      String(call[0]).includes("/providers?location="),
    );
    expect(canonicalCalls).toHaveLength(0);
  });

  it("fetchPatientsByProviderDate does not call the canonical /appointments endpoint", async () => {
    await expect(
      fetchPatientsByProviderDate("Excelsia.28.1", "2026-06-03", "", "pennsylvania"),
    ).rejects.toThrow();

    const canonicalCalls = (global.fetch as jest.Mock).mock.calls.filter((call) =>
      String(call[0]).includes("/appointments?location="),
    );
    expect(canonicalCalls).toHaveLength(0);
  });
});
