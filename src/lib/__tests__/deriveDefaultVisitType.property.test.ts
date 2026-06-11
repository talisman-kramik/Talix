/**
 * Property-based test for mobile Default_Visit_Type derivation (Task 5.2).
 *
 * Feature: recording-visit-type-selector, Property 4: Default derivation maps
 * New→initial_evaluation, else→follow_up, never discharge
 *
 * Validates: Requirements 5.1, 5.2, 5.3
 */
import fc from "fast-check";
import { deriveDefaultVisitType } from "../api";

const NUM_RUNS = 100;

describe("deriveDefaultVisitType — Property 4 (mobile default derivation)", () => {
  // An arbitrary that produces case-variant spellings of "new" optionally
  // padded with surrounding whitespace, e.g. "  New ", "NEW", "nEw\t".
  const whitespace = fc.constantFrom("", " ", "  ", "\t", "\n", "\r", " \t ", "   ");
  const newCasing = fc
    .tuple(
      fc.constantFrom("n", "N"),
      fc.constantFrom("e", "E"),
      fc.constantFrom("w", "W"),
    )
    .map(([a, b, c]) => a + b + c);
  const newVariant = fc
    .tuple(whitespace, newCasing, whitespace)
    .map(([lead, core, trail]) => lead + core + trail);

  // Feature: recording-visit-type-selector, Property 4: Default derivation maps
  // New→initial_evaluation, else→follow_up, never discharge
  it("returns initial_evaluation for any whitespace-padded casing of 'new'", () => {
    fc.assert(
      fc.property(newVariant, (value) => {
        expect(deriveDefaultVisitType(value)).toBe("initial_evaluation");
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: recording-visit-type-selector, Property 4: Default derivation maps
  // New→initial_evaluation, else→follow_up, never discharge
  it("returns follow_up for empty, null/undefined, and arbitrary non-'new' strings, never discharge", () => {
    // Inputs that are NOT a trimmed, lower-cased "new": empty string,
    // null/undefined (missing flag), and arbitrary strings constrained to
    // exclude the "new" case. "Repeat" is included as a representative value.
    const nonNewArbitrary = fc.oneof(
      fc.constant(""),
      fc.constant(null),
      fc.constant(undefined),
      fc.constant("Repeat"),
      fc
        .string()
        .filter((s) => s.trim().toLowerCase() !== "new"),
    );

    fc.assert(
      fc.property(nonNewArbitrary, (value) => {
        const result = deriveDefaultVisitType(value);
        expect(result).toBe("follow_up");
        // Discharge is never the derived default.
        expect(result).not.toBe("discharge");
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: recording-visit-type-selector, Property 4: Default derivation maps
  // New→initial_evaluation, else→follow_up, never discharge
  it("never returns discharge for any string, null, or undefined input", () => {
    const anyInput = fc.oneof(
      fc.constant(null),
      fc.constant(undefined),
      fc.string(),
      newVariant,
    );

    fc.assert(
      fc.property(anyInput, (value) => {
        const result = deriveDefaultVisitType(value);
        expect(result).not.toBe("discharge");
        // The mapping is total over the allowed default set.
        expect(["initial_evaluation", "follow_up"]).toContain(result);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
