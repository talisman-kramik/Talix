/**
 * Date formatting helpers shared across the app.
 *
 * Canonical user-facing format: MM/DD/YYYY.
 * Inputs may arrive in many shapes (ISO date, ISO timestamp, MM/DD/YYYY,
 * "Unknown", null, undefined), so the formatter is defensive.
 */

const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function isUnknown(value: string): boolean {
  const lc = value.toLowerCase();
  return lc === "unknown" || lc === "n/a" || lc === "na" || lc === "null";
}

function pad2(n: number | string): string {
  return String(n).padStart(2, "0");
}

/**
 * Format any reasonable date input as MM/DD/YYYY.
 * Returns "N/A" when the input is empty / missing / "Unknown".
 * Returns the original string when the format can't be parsed.
 */
export function formatDateUS(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw || isUnknown(raw)) return "N/A";

  // Already MM/DD/YYYY (or M/D/YYYY) → normalize zero padding.
  const slash = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) {
    const [, m, d, y] = slash;
    return `${pad2(m)}/${pad2(d)}/${y}`;
  }

  // ISO date or timestamp: YYYY-MM-DD (with optional time after).
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const [, y, m, d] = iso;
    return `${m}/${d}/${y}`;
  }

  // Fallback: let JS try to parse it.
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return `${pad2(parsed.getMonth() + 1)}/${pad2(parsed.getDate())}/${parsed.getFullYear()}`;
  }

  return raw;
}

/**
 * Format an ISO date (YYYY-MM-DD) as a friendly label like "May 12, 2026".
 * Used in places where a longer humanized date reads better than MM/DD/YYYY.
 * Falls back to formatDateUS when parsing fails.
 */
export function formatDateLong(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw || isUnknown(raw)) return "N/A";
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const [, y, m, d] = iso;
    const monthIdx = Number(m) - 1;
    const monthName = MONTHS_SHORT[monthIdx] ?? m;
    return `${monthName} ${Number(d)}, ${y}`;
  }
  return formatDateUS(raw);
}
