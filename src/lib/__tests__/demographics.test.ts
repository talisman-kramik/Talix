/**
 * Unit tests for demographics payload construction (Task 13.2)
 * Validates: Requirements 8.1, 8.2
 */
import {
  buildEncounterDetails,
  validateProviderName,
  uploadEncounterAudio,
  type EncounterDemographics,
} from "../api";

// ---------------------------------------------------------------------------
// Test: buildEncounterDetails includes all 7 required fields
// ---------------------------------------------------------------------------

describe("buildEncounterDetails", () => {
  it("includes all 7 required fields", () => {
    const result = buildEncounterDetails({
      providerName: "Dr. Smith",
      patientName: "John Doe",
      patientDob: "1990-05-15",
      accountNumber: "ACC001",
      caseName: "Follow-up",
      locationName: "Baltimore",
      systemLocation: "baltimore",
    });

    expect(result).toHaveProperty("provider_name");
    expect(result).toHaveProperty("patient_name");
    expect(result).toHaveProperty("patient_dob");
    expect(result).toHaveProperty("account_number");
    expect(result).toHaveProperty("case_name");
    expect(result).toHaveProperty("location_name");
    expect(result).toHaveProperty("system_location");

    expect(result.provider_name).toBe("Dr. Smith");
    expect(result.patient_name).toBe("John Doe");
    expect(result.patient_dob).toBe("1990-05-15");
    expect(result.account_number).toBe("ACC001");
    expect(result.case_name).toBe("Follow-up");
    expect(result.location_name).toBe("Baltimore");
    expect(result.system_location).toBe("baltimore");
  });

  it("patient_dob is passed through as-is (caller responsible for YYYY-MM-DD format)", () => {
    const result = buildEncounterDetails({
      providerName: "Dr. Jones",
      patientName: "Jane Doe",
      patientDob: "2000-12-31",
    });

    // The function passes through the dob value without transformation
    expect(result.patient_dob).toBe("2000-12-31");
  });

  it("defaults missing optional fields to empty string", () => {
    const result = buildEncounterDetails({
      providerName: "Dr. Smith",
      patientName: "John Doe",
      patientDob: "1990-05-15",
      // accountNumber, caseName, locationName, systemLocation omitted
    });

    expect(result.account_number).toBe("");
    expect(result.case_name).toBe("");
    expect(result.location_name).toBe("");
    expect(result.system_location).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Test: validateProviderName
// ---------------------------------------------------------------------------

describe("validateProviderName", () => {
  it('returns true for "Dr. Smith" (non-empty, non-whitespace)', () => {
    expect(validateProviderName("Dr. Smith")).toBe(true);
  });

  it('returns false for "" (empty string)', () => {
    expect(validateProviderName("")).toBe(false);
  });

  it('returns false for "   " (whitespace-only)', () => {
    expect(validateProviderName("   ")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test: uploadEncounterAudio throws if demographics provided with invalid provider_name
// ---------------------------------------------------------------------------

describe("uploadEncounterAudio", () => {
  beforeEach(() => {
    (global.fetch as jest.Mock).mockReset();
  });

  it("throws if demographics provided with invalid (empty) provider_name", async () => {
    const demographics: EncounterDemographics = {
      provider_name: "",
      patient_name: "John Doe",
      patient_dob: "1990-05-15",
      account_number: "ACC001",
      case_name: "Follow-up",
      location_name: "Baltimore",
      system_location: "baltimore",
    };

    await expect(
      uploadEncounterAudio("enc123", "file:///audio.m4a", "recording.m4a", null, null, demographics),
    ).rejects.toThrow("provider_name must contain at least 1 non-whitespace character");

    // fetch should not have been called
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("throws if demographics provided with whitespace-only provider_name", async () => {
    const demographics: EncounterDemographics = {
      provider_name: "   ",
      patient_name: "John Doe",
      patient_dob: "1990-05-15",
      account_number: "ACC001",
      case_name: "Follow-up",
      location_name: "Baltimore",
      system_location: "baltimore",
    };

    await expect(
      uploadEncounterAudio("enc123", "file:///audio.m4a", "recording.m4a", null, null, demographics),
    ).rejects.toThrow("provider_name must contain at least 1 non-whitespace character");

    expect(global.fetch).not.toHaveBeenCalled();
  });
});
