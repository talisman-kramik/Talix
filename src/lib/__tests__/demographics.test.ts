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
  formatProviderNameFirstLast,
  resolveEclipseAppointmentProviderId,
  resolveEclipsePatientDob,
  isGenericAppointmentLabel,
  isLikelyCaseCode,
  inferVisitTypeFromAppointmentClass,
  resolveVisitType,
  mapNewRepeatPatientToVisitType,
  isExcludedAppointmentStatus,
  dedupePatientsPreferCase,
  formatPatientNameLastFirst,
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

  it("strips the .Excelsia suffix (both locations)", () => {
    expect(normalizeAccountNumber("9936.1.Excelsia")).toBe("9936.1");
    expect(normalizeAccountNumber("54552.Excelsia")).toBe("54552");
    expect(normalizeAccountNumber("AMM_LIVE.1.218174.0.Excelsia")).toBe("1.218174.0");
  });

  it("strips the Eclipse. prefix from Pennsylvania provider ids", () => {
    expect(normalizeAccountNumber("Eclipse.132")).toBe("132");
    expect(normalizeAccountNumber("Eclipse.33.4.Excelsia")).toBe("33.4");
  });

  it("leaves already-clean values unchanged", () => {
    expect(normalizeAccountNumber("1.218174.0")).toBe("1.218174.0");
    expect(normalizeAccountNumber("132")).toBe("132");
    expect(normalizeAccountNumber("")).toBe("");
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

describe("formatPatientNameLastFirst", () => {
  it("formats first/last into LAST, FIRST", () => {
    expect(formatPatientNameLastFirst("ADMIRAL", "ADDY")).toBe("ADDY, ADMIRAL");
  });

  it("returns the single available name when one part is missing", () => {
    expect(formatPatientNameLastFirst("ADMIRAL", "")).toBe("ADMIRAL");
    expect(formatPatientNameLastFirst("", "ADDY")).toBe("ADDY");
    expect(formatPatientNameLastFirst("", "")).toBe("");
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

describe("formatProviderNameFirstLast", () => {
  it('converts "Pello, Scott" to "Scott Pello"', () => {
    expect(formatProviderNameFirstLast("Pello, Scott")).toBe("Scott Pello");
  });

  it("leaves an already first-last name unchanged", () => {
    expect(formatProviderNameFirstLast("Scott Pello")).toBe("Scott Pello");
  });

  it("handles a single name", () => {
    expect(formatProviderNameFirstLast("Pello")).toBe("Pello");
  });

  it("returns empty string for empty input", () => {
    expect(formatProviderNameFirstLast("")).toBe("");
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

describe("inferVisitTypeFromAppointmentClass", () => {
  it("maps new-patient / consult classes to initial_evaluation", () => {
    expect(inferVisitTypeFromAppointmentClass("CONSULT")).toBe("initial_evaluation");
    expect(inferVisitTypeFromAppointmentClass("New Pt Eval")).toBe("initial_evaluation");
    expect(inferVisitTypeFromAppointmentClass("INT MVA")).toBe("initial_evaluation");
    expect(inferVisitTypeFromAppointmentClass("1ST VISIT")).toBe("initial_evaluation");
  });

  it("maps everything else (incl. unknown/empty) to follow_up", () => {
    expect(inferVisitTypeFromAppointmentClass("Follow-Up")).toBe("follow_up");
    expect(inferVisitTypeFromAppointmentClass("Office Visit")).toBe("follow_up");
    expect(inferVisitTypeFromAppointmentClass("Auto Accident")).toBe("follow_up");
    expect(inferVisitTypeFromAppointmentClass("")).toBe("follow_up");
    expect(inferVisitTypeFromAppointmentClass(null)).toBe("follow_up");
  });
});

describe("resolveVisitType", () => {
  it("always returns default for Pennsylvania regardless of appointment class", () => {
    expect(resolveVisitType("pennsylvania", "CONSULT")).toBe("default");
    expect(resolveVisitType("pennsylvania", "Follow-Up")).toBe("default");
    expect(resolveVisitType("pennsylvania", "")).toBe("default");
  });

  it("infers from appointment class for Baltimore", () => {
    expect(resolveVisitType("baltimore", "NEWPT")).toBe("initial_evaluation");
    expect(resolveVisitType("baltimore", "Follow-Up")).toBe("follow_up");
    expect(resolveVisitType("baltimore", "")).toBe("follow_up");
  });

  it("prefers the new_repeat_patient flag for both locations (web parity)", () => {
    // New → initial_evaluation, even for Pennsylvania (overrides "default").
    expect(resolveVisitType("pennsylvania", "Follow-Up", "New")).toBe("initial_evaluation");
    expect(resolveVisitType("baltimore", "", "New")).toBe("initial_evaluation");
    // Repeat → follow_up, even when appointment class looks like a new visit.
    expect(resolveVisitType("pennsylvania", "CONSULT", "Repeat")).toBe("follow_up");
    expect(resolveVisitType("baltimore", "NEWPT", "Repeat")).toBe("follow_up");
  });

  it("falls back to per-location logic when new_repeat_patient is empty/unknown", () => {
    expect(resolveVisitType("pennsylvania", "CONSULT", "")).toBe("default");
    expect(resolveVisitType("pennsylvania", "CONSULT", "Unknown")).toBe("default");
    expect(resolveVisitType("baltimore", "NEWPT", null)).toBe("initial_evaluation");
    expect(resolveVisitType("baltimore", "Office Visit", undefined)).toBe("follow_up");
  });
});

describe("mapNewRepeatPatientToVisitType", () => {
  it('maps "New" → initial_evaluation (case-insensitive)', () => {
    expect(mapNewRepeatPatientToVisitType("New")).toBe("initial_evaluation");
    expect(mapNewRepeatPatientToVisitType(" new ")).toBe("initial_evaluation");
    expect(mapNewRepeatPatientToVisitType("NEW")).toBe("initial_evaluation");
  });

  it('maps "Repeat" → follow_up (case-insensitive)', () => {
    expect(mapNewRepeatPatientToVisitType("Repeat")).toBe("follow_up");
    expect(mapNewRepeatPatientToVisitType(" repeat ")).toBe("follow_up");
  });

  it("returns null for empty / unknown values", () => {
    expect(mapNewRepeatPatientToVisitType("")).toBeNull();
    expect(mapNewRepeatPatientToVisitType(null)).toBeNull();
    expect(mapNewRepeatPatientToVisitType(undefined)).toBeNull();
    expect(mapNewRepeatPatientToVisitType("Maybe")).toBeNull();
  });
});

describe("isExcludedAppointmentStatus", () => {
  it("excludes cancelled-type statuses (case-insensitive)", () => {
    expect(isExcludedAppointmentStatus("Missed")).toBe(true);
    expect(isExcludedAppointmentStatus("rescheduled")).toBe(true);
    expect(isExcludedAppointmentStatus("Cancelled")).toBe(true);
    expect(isExcludedAppointmentStatus("Canceled")).toBe(true);
    expect(isExcludedAppointmentStatus(" No Show ")).toBe(true);
  });

  it("keeps active statuses", () => {
    expect(isExcludedAppointmentStatus("Confirmed")).toBe(false);
    expect(isExcludedAppointmentStatus("Arrived")).toBe(false);
    expect(isExcludedAppointmentStatus("Seen")).toBe(false);
    expect(isExcludedAppointmentStatus("")).toBe(false);
    expect(isExcludedAppointmentStatus(null)).toBe(false);
  });
});

describe("dedupePatientsPreferCase", () => {
  const base = {
    first_name: "SAMUEL",
    last_name: "GIRON SIGUENZA",
    date_of_birth: "1993-10-10",
    sex: "",
    practice_id: "Eclipse",
  };

  it("keeps one row per patient, preferring the row that has a case name", () => {
    const rows: PatientSearchResult[] = [
      {
        ...base,
        id: "AMM_LIVE.1.225680.0.0",
        mrn: "AMM_LIVE.1.225680.0.0",
        patient_case_id: "AMM_LIVE.1.225680.0.0",
        patient_id_raw: "AMM_LIVE.1.225680.0",
        case_name: undefined,
      },
      {
        ...base,
        id: "AMM_LIVE.1.225680.0.1",
        mrn: "AMM_LIVE.1.225680.0.1",
        patient_case_id: "AMM_LIVE.1.225680.0.1",
        patient_id_raw: "AMM_LIVE.1.225680.0",
        case_name: "WC102824",
      },
    ];
    const result = dedupePatientsPreferCase(rows);
    expect(result).toHaveLength(1);
    expect(result[0].case_name).toBe("WC102824");
  });

  it("keeps distinct patients separate", () => {
    const rows: PatientSearchResult[] = [
      {
        ...base,
        id: "AMM_LIVE.1.111.0.1",
        mrn: "AMM_LIVE.1.111.0.1",
        patient_case_id: "AMM_LIVE.1.111.0.1",
        patient_id_raw: "AMM_LIVE.1.111.0",
        case_name: "WC1",
      },
      {
        ...base,
        id: "AMM_LIVE.1.222.0.1",
        mrn: "AMM_LIVE.1.222.0.1",
        patient_case_id: "AMM_LIVE.1.222.0.1",
        patient_id_raw: "AMM_LIVE.1.222.0",
        case_name: "WC2",
      },
    ];
    expect(dedupePatientsPreferCase(rows)).toHaveLength(2);
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
    expect(result.provider_name).toBe("Adel Kebaish");
    expect(result.supervising_physician).toBe("Adel Kebaish");
    expect(result.rendering_provider).toBe("Adel Kebaish");
    expect(result.d_o_b).toBe("1964-06-27");
    expect(result.injury_date).toBe("2025-05-21");
    expect(result.date_of_injury).toBe("2025-05-21");
  });

  it("uses the explicitly selected visit date for the DATE OF EXAM field", () => {
    const result = buildEncounterDetailsFromPatient({
      patient,
      providerName: "Adel Kebaish",
      systemLocation: "baltimore",
      date: "2026-01-13",
    });
    expect(result.date).toBe("2026-01-13");
  });

  it("falls back to the patient's Eclipse appointment date when no date is selected", () => {
    const result = buildEncounterDetailsFromPatient({
      patient: { ...patient, appointment_at: "2026-02-09T10:30:00Z" },
      providerName: "Adel Kebaish",
      systemLocation: "baltimore",
    });
    expect(result.date).toBe("2026-02-09");
  });

  it("omits date when neither a selected date nor an appointment date is available", () => {
    const result = buildEncounterDetailsFromPatient({
      patient,
      providerName: "Adel Kebaish",
      systemLocation: "baltimore",
    });
    expect(result).not.toHaveProperty("date");
  });
});

describe("resolveClientEncounterId", () => {
  it("builds the 4-part composite for Baltimore, stripping the AMM_LIVE. prefix", () => {
    expect(
      resolveClientEncounterId({
        location: "baltimore",
        appointmentId: "40709553",
        patientCaseId: "AMM_LIVE.1.84915.0.2",
        providerId: "Excelsia.30.2",
        dateOfService: "2026-06-03",
      }),
    ).toBe("1.84915.0.2_40709553_Excelsia.30.2_20260603");
  });

  it("strips the AMM_LIVE. prefix from the Baltimore provider id too", () => {
    expect(
      resolveClientEncounterId({
        location: "baltimore",
        appointmentId: "40687289",
        patientCaseId: "AMM_LIVE.1.227900.0.1",
        providerId: "AMM_LIVE.146",
        dateOfService: "2026-06-04",
      }),
    ).toBe("1.227900.0.1_40687289_146_20260604");
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

  it("builds the 4-part EHR composite for Pennsylvania, stripping Eclipse markers", () => {
    expect(
      resolveClientEncounterId({
        location: "pennsylvania",
        patientCaseId: "10200.2.Excelsia",
        appointmentId: "44290913",
        providerId: "Eclipse.79",
        dateOfService: "2026-06-03",
      }),
    ).toBe("10200.2_44290913_79_20260603");
  });

  it("matches the spec example for Pennsylvania", () => {
    expect(
      resolveClientEncounterId({
        location: "pennsylvania",
        patientCaseId: "998877",
        appointmentId: "445566",
        providerId: "Excelsia.7.2",
        dateOfService: "2026-05-09",
      }),
    ).toBe("998877_445566_Excelsia.7.2_20260509");
  });

  it("strips a trailing _YYYYMMDD already present on the PA appointment id", () => {
    expect(
      resolveClientEncounterId({
        location: "pennsylvania",
        patientCaseId: "998877",
        appointmentId: "445566_20260509",
        providerId: "Excelsia.7.2",
        dateOfService: "2026-05-09",
      }),
    ).toBe("998877_445566_Excelsia.7.2_20260509");
  });

  it("removes internal spaces from PA segments but keeps . and -", () => {
    expect(
      resolveClientEncounterId({
        location: "pennsylvania",
        patientCaseId: " 10200.2.Excelsia ",
        appointmentId: "44 290 913",
        providerId: "Eclipse.28-1",
        dateOfService: "2026-06-03",
      }),
    ).toBe("10200.2_44290913_28-1_20260603");
  });

  it("emits unknown for missing PA fields", () => {
    expect(
      resolveClientEncounterId({
        location: "pennsylvania",
        patientCaseId: "10200.2.Excelsia",
        appointmentId: "",
        providerId: "Eclipse.28.1",
        dateOfService: "2026-06-03",
      }),
    ).toBe("10200.2_unknown_28.1_20260603");
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
