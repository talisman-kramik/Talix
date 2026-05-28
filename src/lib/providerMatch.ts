/**
 * Provider matching helpers — shared between RecordScreen (interactive
 * auto-select) and App.tsx (background patient prefetch at login).
 *
 * Extracted from RecordScreen so the prefetch logic doesn't have to either
 * duplicate the matcher or pull in screen-level state.
 */
import type { ProviderSummary } from "./api";

/** Lower-case, strip honorifics + credentials + punctuation, return tokens. */
export function tokensFromName(value: unknown): string[] {
  return String(value ?? "")
    .toLowerCase()
    .replace(/^(dr|mr|mrs|ms|miss|prof)\.?\s+/i, "")
    .replace(/,\s*/g, " ")
    .replace(/\b(md|do|phd|rn|np|pa|dds|dmd|esq|jr|sr|ii|iii|iv)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Match the logged-in user against the provider list. Returns provider id
 * when there is a single confident match; otherwise null (caller leaves
 * selection empty so the user picks manually).
 */
export function findProviderForUser(
  providers: ProviderSummary[],
  user: { name?: string | null; email?: string | null } | null | undefined,
): string | null {
  if (!user || providers.length === 0) return null;

  // Handle "Last, First" by swapping order before tokenization.
  const rawName = String(user.name ?? "").trim();
  const swappedName = rawName.includes(",")
    ? rawName
        .split(",")
        .map((s) => s.trim())
        .reverse()
        .join(" ")
    : rawName;
  const userTokens = tokensFromName(swappedName);

  // 1. Exact match on joined normalized tokens.
  if (userTokens.length > 0) {
    const userJoined = userTokens.join(" ");
    const exact = providers.find(
      (p) => tokensFromName(p.name ?? p.id).join(" ") === userJoined,
    );
    if (exact) return exact.id;
  }

  // Token-subset matcher: every query token must be present in the provider's
  // tokens. Requires at least 2 tokens to avoid false positives from a single
  // common last name.
  const subsetMatches = (queryTokens: string[]): ProviderSummary[] => {
    if (queryTokens.length < 2) return [];
    return providers.filter((p) => {
      const set = new Set(tokensFromName(p.name ?? p.id));
      return queryTokens.every((t) => set.has(t));
    });
  };

  // 2. Subset match on display name (handles middle names/initials).
  const nameMatches = subsetMatches(userTokens);
  if (nameMatches.length === 1) return nameMatches[0].id;
  if (nameMatches.length > 1) return null;

  // 3. Fallback: email local-part tokens (e.g. caleb.ademiloye@…).
  const email = String(user.email ?? "").trim().toLowerCase();
  const localPart = email.includes("@") ? email.split("@")[0] : email;
  const emailTokens = localPart
    .replace(/[._\-+0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  const emailMatches = subsetMatches(emailTokens);
  if (emailMatches.length === 1) return emailMatches[0].id;

  return null;
}
