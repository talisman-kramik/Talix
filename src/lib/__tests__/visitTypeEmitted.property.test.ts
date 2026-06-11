/**
 * Property-based test for mobile client-emitted visit_type membership (Task 5.3)
 *
 * Feature: recording-visit-type-selector, Property 5: Client-emitted visit_type is always a member of the Allowed_Visit_Type_Set
 *
 * Validates: Requirements 6.3
 */
import fc from "fast-check";
import { buildEncounterDetails, VISIT_TYPES } from "../api";

// The Allowed_Visit_Type_Set — exactly the values exposed by the selector.
const ALLOWED_VISIT_TYPES = new Set(VISIT_TYPES.map((option) => option.value));

// Generator constrained to the selectable options' values (the only values a
// provider can emit through the Visit Type selector).
const selectableVisitType = fc.constantFrom(...VISIT_TYPES.map((option) => option.value));

describe("Property 5: mobile client-emitted visit_type membership", () => {
  it("buildEncounterDetails always sets visit_type to a member of the Allowed_Visit_Type_Set", () => {
    fc.assert(
      fc.property(
        selectableVisitType,
        fc.string(),
        fc.string(),
        fc.string(),
        (visitType, providerName, patientName, patientDob) => {
          const demographics = buildEncounterDetails({
            // provider_name must be non-empty for a realistic payload, but the
            // visit_type behavior under test is independent of the other fields.
            providerName: providerName.trim() || "Provider",
            patientName,
            patientDob,
            visitType,
          });

          // The emitted visit_type must equal the selected value and be a
          // member of the Allowed_Visit_Type_Set.
          expect(demographics.visit_type).toBe(visitType);
          expect(ALLOWED_VISIT_TYPES.has(demographics.visit_type as string)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});
