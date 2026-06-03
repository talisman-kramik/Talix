/**
 * Unit tests for demographics payload construction (Task 13.2)
 * Validates: Requirements 8.1, 8.2
 */
import {
  buildEncounterDetails,
  buildEncounterDetailsFromPatient,
  classifyCaseNumberForUpload,
  formatEncounterDetailsDebugMessage,
  formatProviderNameLastFirst,
  resolveEclipseAppointmentProviderId,
  resolveEclipsePatientDob,
  isGenericAppointmentLabel,
  isLikelyCaseCode,
  normalizeAccountNumber,
  normalizePatientDob,
  parseInjuryDateFromCaseLabel,
  resolveInjuryDate,
  resolveBackendProviderId,
  resolveCaseNumber,
  resolveClientEncounterId,
  resolvePatientCaseName,
  resolvePmAccountNumber,
  validateProviderName,
  uploadEncounterAudio,
  type EncounterDemographics,
  type PatientSearchResult,
} from "../api";

// ---------------------------------------------------------------------------
// Test: buildEncounterDetails includes all required fields
// ---------------------------------------------------------------------------

describe("buildEncounterDetails", () => {
  it("includes all core fields and optional SOAP header fields", () => {
    const result = buildEncounterDetails({
      providerName: "Dr. Smith",
      patientName: "John Doe",
      patientDob: "1990-05-15",
      accountNumber: "ACC001",
      caseName: "MD (MVA030925)",
      caseNumber: "AMM_LIVE.1.228977.0.1",
      injuryDate: "2025-03-09",
      supervisingPhysician: "Dr. Smith",
      locationName: "Baltimore",
      systemLocation: "baltimore",
    });

    expect(result.provider_name).toBe("Dr. Smith");
    expect(result.patient_name).toBe("John Doe");
    expect(result.patient_dob).toBe("1990-05-15");
    expect(result.account_number).toBe("ACC001");
    expect(result.case_name).toBe("MD (MVA030925)");
    expect(result.case_number).toBe("AMM_LIVE.1.228977.0.1");
    expect(result.injury_date).toBe("2025-03-09");
    expect(result.supervising_physician).toBe("Dr. Smith");
    expect(result.location_name).toBe("Baltimore");
    expect(result.system_location).toBe("baltimore");
  });

  it("omits optional SOAP fields when blank", () => {
    const result = buildEncounterDetails({
      providerName: "Dr. Smith",
      patientName: "John Doe",
      patientDob: "1990-05-15",
    });

    expect(result).not.toHaveProperty("case_number");
    expect(result).not.toHaveProperty("injury_date");
    expect(result).not.toHaveProperty("supervising_physician");
    expect(result.account_number).toBe("");
    expect(result.case_name).toBe("");
  });
});

describe("normalizeAccountNumber", () => {
  it("strips AMM_LIVE. prefix from Baltimore account numbers", () => {
    expect(normalizeAccountNumber("AMM_LIVE.1.228977.0.1")).toBe("1.228977.0.1");
    expect(normalizeAccountNumber("AMM_LIVE.1.218174.0")).toBe("1.218174.0");
  });

  it("passes through Pennsylvania-style account numbers unchanged", () => {
    expect(normalizeAccountNumber("12345.1.Excelsia")).toBe("12345.1.Excelsia");
  });
});

describe("resolvePmAccountNumber", () => {
  it("uses patient_id (no case suffix) for Baltimore PM account", () => {
    expect(
      resolvePmAccountNumber({
        patient_id_raw: "AMM_LIVE.1.218174.0",
        patient_case_id: "AMM_LIVE.1.218174.0.1",
        mrn: "AMM_LIVE.1.218174.0.1",
      }),
    ).toBe("1.218174.0");
  });

  it("drops trailing case segment when patient_id is missing", () => {
    expect(
      resolvePmAccountNumber({
        patient_case_id: "AMM_LIVE.1.218174.0.1",
        mrn: "AMM_LIVE.1.218174.0.1",
      }),
    ).toBe("1.218174.0");
  });
});

describe("parseInjuryDateFromCaseLabel", () => {
  it("parses MVA code from MD(MVA051625) as 2025-05-16", () => {
    expect(parseInjuryDateFromCaseLabel("MD(MVA051625)")).toBe("2025-05-16");
  });

  it("parses spaced MVA code MD (MVA030925) as 2025-03-09", () => {
    expect(parseInjuryDateFromCaseLabel("MD (MVA030925)")).toBe("2025-03-09");
  });

  it("parses PI code from REHAB (PI011625) as 2025-01-16", () => {
    expect(parseInjuryDateFromCaseLabel("REHAB  (PI011625)")).toBe("2025-01-16");
  });

  it("returns empty when no MVA/WC/PI date code present", () => {
    expect(parseInjuryDateFromCaseLabel("Auto Accident")).toBe("");
  });
});

describe("resolveInjuryDate", () => {
  it("prefers Eclipse date_of_injury when present", () => {
    expect(
      resolveInjuryDate({
        date_of_injury: "2025-06-28",
        case_name: "MD(MVA051625)",
      }),
    ).toBe("2025-06-28");
  });

  it("falls back to case_name MVA code when date_of_injury is missing", () => {
    expect(
      resolveInjuryDate({
        date_of_injury: undefined,
        case_name: "MD(MVA051625)",
        case_number: "MD(MVA051625)",
      }),
    ).toBe("2025-05-16");
  });
});

describe("resolveCaseNumber", () => {
  it("prefers backend case_number over case_name", () => {
    expect(
      resolveCaseNumber({
        case_number: "9534.1.Excelsia",
        case_name: "MD (WC010214)",
      }),
    ).toBe("9534.1.Excelsia");
  });

  it("uses Eclipse case_name for WC-style case codes (Pennsylvania)", () => {
    expect(
      resolveCaseNumber({ case_name: "MD (WC010214)", appointment_class: "Workers Compensation" }),
    ).toBe("MD (WC010214)");
  });

  it("returns empty when both case_number and case_name are missing", () => {
    expect(
      resolveCaseNumber({ case_name: undefined, appointment_class: "Auto Accident" }),
    ).toBe("");
  });

  it("ignores Micro record ids mistaken for case_number (Baltimore)", () => {
    expect(
      resolveCaseNumber({
        case_number: "1.218174.0.1",
        case_name: undefined,
        appointment_class: "Auto Accident",
      }),
    ).toBe("");
  });

  it("uses SQL poi.case_name style codes (e.g. AWC11326)", () => {
    expect(
      resolveCaseNumber({
        case_number: "",
        case_name: "AWC11326",
        appointment_class: "Workers Compensation",
      }),
    ).toBe("AWC11326");
  });
});

describe("classifyCaseNumberForUpload", () => {
  it("flags follow_up as generic", () => {
    expect(classifyCaseNumberForUpload("follow_up")).toBe("generic");
    expect(classifyCaseNumberForUpload("FOLLOW_UP")).toBe("generic");
  });

  it("accepts AWC-style Baltimore codes as real", () => {
    expect(classifyCaseNumberForUpload("AWC11326")).toBe("real");
  });

  it("returns empty when no case code", () => {
    expect(classifyCaseNumberForUpload("")).toBe("empty");
  });
});

describe("formatEncounterDetailsDebugMessage", () => {
  it("includes Baltimore verdict line for real case code", () => {
    const msg = formatEncounterDetailsDebugMessage({
      systemLocation: "baltimore",
      demographics: {
        provider_name: "Rahman, Faraz",
        patient_name: "Karen Harvey",
        patient_dob: "",
        account_number: "1.229713.0",
        case_name: "AWC11326",
        case_number: "AWC11326",
        location_name: "Columbia",
        system_location: "baltimore",
        injury_date: "2026-04-10",
      },
      patient: {
        id: "1",
        first_name: "Karen",
        last_name: "Harvey",
        date_of_birth: "1962-01-18",
        sex: "",
        mrn: "1.229713.0.1",
        practice_id: "Eclipse",
        appointment_class: "follow_up",
        provider_source_id: "42",
      },
    });
    expect(msg).toContain("REAL case code");
    expect(msg).toContain("case_number: AWC11326");
    expect(msg).toContain("appointment_provider_id: 42");
    expect(msg).toContain("date_of_birth: 1962-01-18");
  });
});

describe("formatProviderNameLastFirst", () => {
  it('converts "Faraz Rahman" to "Rahman, Faraz"', () => {
    expect(formatProviderNameLastFirst("Faraz Rahman")).toBe("Rahman, Faraz");
  });

  it("leaves already-formatted names unchanged", () => {
    expect(formatProviderNameLastFirst("Rahman, Faraz")).toBe("Rahman, Faraz");
  });
});

describe("isGenericAppointmentLabel", () => {
  it("treats follow_up as a generic appointment class", () => {
    expect(isGenericAppointmentLabel("follow_up")).toBe(true);
    expect(isGenericAppointmentLabel("FOLLOW_UP")).toBe(true);
  });
});

describe("isLikelyCaseCode", () => {
  it("rejects appointment class labels", () => {
    expect(isLikelyCaseCode("Workers Compensation")).toBe(false);
    expect(isLikelyCaseCode("follow_up")).toBe(false);
  });

  it("accepts Baltimore SQL case codes", () => {
    expect(isLikelyCaseCode("AWC11326")).toBe(true);
  });
});

describe("resolveBackendProviderId", () => {
  it("extracts numeric id from eclid-encoded provider ids", () => {
    expect(resolveBackendProviderId("eclid:42|Adel|Kebaish")).toBe(42);
  });

  it("accepts plain numeric backend provider ids", () => {
    expect(resolveBackendProviderId("123")).toBe(123);
  });

  it("returns null for name-only encoded ids", () => {
    expect(resolveBackendProviderId("eclname:Adel|Kebaish")).toBeNull();
  });
});

describe("resolveEclipsePatientDob", () => {
  it("reads patient_dob_at (primary Eclipse field)", () => {
    expect(resolveEclipsePatientDob({ patient_dob_at: "1962-01-18T00:00:00Z" })).toBe(
      "1962-01-18",
    );
  });

  it("falls back to patient_dob alias", () => {
    expect(resolveEclipsePatientDob({ patient_dob: "1980-04-19" })).toBe("1980-04-19");
  });
});

describe("resolveEclipseAppointmentProviderId", () => {
  it("returns appointment_provider_id when present", () => {
    expect(resolveEclipseAppointmentProviderId({ appointment_provider_id: 42 })).toBe("42");
  });

  it("ignores zero id", () => {
    expect(resolveEclipseAppointmentProviderId({ appointment_provider_id: 0 })).toBe("");
  });
});

describe("normalizePatientDob", () => {
  it("normalises ISO datetime to YYYY-MM-DD", () => {
    expect(normalizePatientDob("2008-04-19T00:00:00Z")).toBe("2008-04-19");
  });

  it("returns empty string for Unknown / missing values", () => {
    expect(normalizePatientDob("Unknown")).toBe("");
    expect(normalizePatientDob("")).toBe("");
    expect(normalizePatientDob(null)).toBe("");
  });
});

describe("resolvePatientCaseName", () => {
  it("prefers case_name over appointment_class", () => {
    expect(
      resolvePatientCaseName({ case_name: "MD (MVA030925)", appointment_class: "Follow Up" }),
    ).toBe("MD (MVA030925)");
  });

  it("does not use generic appointment_class as case_name (Baltimore)", () => {
    expect(
      resolvePatientCaseName({
        case_name: undefined,
        appointment_class: "Workers Compensation",
      }),
    ).toBe("");
  });

  it("does not use follow_up appointment class as case_name", () => {
    expect(
      resolvePatientCaseName({
        case_name: undefined,
        appointment_class: "follow_up",
      }),
    ).toBe("");
  });
});

describe("buildEncounterDetailsFromPatient — Baltimore case code", () => {
  it("puts WC code in case_name for rqlite/SOAP (not appointment class)", () => {
    const result = buildEncounterDetailsFromPatient({
      patient: {
        id: "1",
        first_name: "Karen",
        last_name: "Harvey",
        date_of_birth: "",
        sex: "",
        mrn: "1.229713.0.1",
        practice_id: "Eclipse",
        case_number: "AWC11326",
        appointment_class: "follow_up",
        date_of_injury: "2026-04-10",
      },
      providerName: "Faraz Rahman",
      systemLocation: "baltimore",
    });
    expect(result.case_number).toBe("AWC11326");
    expect(result.case_name).toBe("AWC11326");
    expect(result).not.toHaveProperty("appointment_class");
  });

  it("omits appointment_class from upload when it is follow_up", () => {
    const result = buildEncounterDetailsFromPatient({
      patient: {
        id: "1",
        first_name: "Karen",
        last_name: "Harvey",
        date_of_birth: "",
        sex: "",
        mrn: "1.229713.0.1",
        practice_id: "Eclipse",
        appointment_class: "follow_up",
      },
      providerName: "Faraz Rahman",
      systemLocation: "baltimore",
    });
    expect(result.case_name).toBe("");
    expect(result).not.toHaveProperty("appointment_class");
  });
});

describe("buildEncounterDetailsFromPatient", () => {
  const patient: PatientSearchResult = {
    id: "42603490",
    first_name: "ELSY",
    last_name: "ALFARO",
    date_of_birth: "1964-06-27",
    sex: "",
    mrn: "1.218174.0.1",
    practice_id: "Backend",
    patient_case_id: "1.218174.0.1",
    patient_id_raw: "1.218174.0",
    case_number: "WC122325",
    case_name: undefined,
    appointment_class: "Auto Accident",
    date_of_injury: "2025-05-21",
    location: "Hyattsville",
    appointment_id: "42603490",
  };

  it("maps PM account, case_number, DOB, injury_date, and SFTP field aliases", () => {
    const result = buildEncounterDetailsFromPatient({
      patient,
      providerName: "Adel Kebaish",
      systemLocation: "baltimore",
    });

    expect(result.account_number).toBe("1.218174.0");
    expect(result.case_number).toBe("WC122325");
    expect(result.case_name).toBe("WC122325");
    expect(result.patient_case_id).toBe("1.218174.0.1");
    expect(result.date_of_injury).toBe("2025-05-21");
    expect(result.patient_dob_at).toBe("1964-06-27");
    expect(result.patient_dob).toBe("1964-06-27");
    expect(result.d_o_b).toBe("1964-06-27");
    expect(result.injury_date).toBe("2025-05-21");
    expect(result.supervising_physician).toBe("Kebaish, Adel");
    expect(result.rendering_provider).toBe("Kebaish, Adel");
    expect(result.d_o_b).toBe("1964-06-27");
    expect(result.injury_date).toBe("2025-05-21");
    expect(result.date_of_injury).toBe("2025-05-21");
  });
});

describe("resolveClientEncounterId", () => {
  it("uses appointment_id for Baltimore (web parity)", () => {
    expect(
      resolveClientEncounterId({
        appointmentId: "42623120",
        patientCaseId: "AMM_LIVE.1.227792.0.1",
        providerId: "0",
        dateOfService: "2026-05-28",
      }),
    ).toBe("42623120");
  });

  it("prefers explicit encounter_id when provided", () => {
    expect(
      resolveClientEncounterId({
        encounterId: "232672",
        appointmentId: "42623120",
        patientCaseId: "AMM_LIVE.1.227792.0.1",
      }),
    ).toBe("232672");
  });

  it("falls back to composite with stripped case id when appointment id missing", () => {
    expect(
      resolveClientEncounterId({
        patientCaseId: "AMM_LIVE.1.227792.0.1",
        providerId: "42",
        dateOfService: "2026-05-28",
      }),
    ).toBe("1.227792.0.1_unknown_42_20260528");
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
