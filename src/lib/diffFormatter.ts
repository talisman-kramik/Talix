/**
 * Diff windowing + metadata stripping for Smart Edit previews.
 *
 * Ported from the web frontend's `DiffRenderer.vue` so mobile and web present
 * identical change-region views to providers. The full amended note can be
 * thousands of characters; rendering all of it on a phone is unreadable, so
 * we collapse equal-only spans down to short context windows around each
 * change and drop pipeline metadata (versions, ASR confidence, horizontal
 * rules) before grouping.
 */
import type { AmendDiffChunk, AmendDiffChunkType } from "./amendService";

export interface DiffGroup {
  /** Up to CONTEXT_CHARS of equal text immediately before this change run. */
  before: string;
  /** The actual changes in this run, with small equal gaps preserved inline. */
  changes: AmendDiffChunk[];
  /** Up to CONTEXT_CHARS of equal text immediately after. */
  after: string;
}

const CONTEXT_CHARS = 120;
/** Equal gaps shorter than this collapse into the surrounding change run. */
const MAX_INLINE_GAP_CHARS = 200;

const METADATA_PATTERNS: RegExp[] = [
  /\*AI Scribe v\d/,
  /ASR conf:/,
  /Note conf:/,
  /PP corrections:/,
  /Pipeline Version:/,
];
const HORIZONTAL_RULE = /^-{3,}\s*$/;

/**
 * Strip the metadata block that precedes the first `## Section` header, plus
 * any pipeline-footer lines (`*AI Scribe v1 | ASR conf: ...*`, `---`, etc.)
 * inside the diff entries. Returns a new array — input is untouched.
 */
export function filterMetadata(diff: AmendDiffChunk[]): AmendDiffChunk[] {
  if (!diff || diff.length === 0) return [];

  const fullText = diff.map((e) => e.text).join("");
  const sectionIdx = fullText.indexOf("## ");
  if (sectionIdx === -1) return stripTrailingMetadata(diff);

  let charCount = 0;
  const result: AmendDiffChunk[] = [];
  for (const entry of diff) {
    const start = charCount;
    charCount += entry.text.length;
    if (charCount <= sectionIdx) continue;
    if (start < sectionIdx) {
      const trimmed = entry.text.slice(sectionIdx - start);
      if (trimmed) result.push({ type: entry.type, text: trimmed });
    } else {
      result.push({ type: entry.type, text: entry.text });
    }
  }
  return stripTrailingMetadata(result);
}

function stripTrailingMetadata(entries: AmendDiffChunk[]): AmendDiffChunk[] {
  if (!entries || entries.length === 0) return [];
  const cleaned: AmendDiffChunk[] = [];
  for (const entry of entries) {
    const lines = entry.text.split("\n");
    const kept = lines.filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      if (HORIZONTAL_RULE.test(trimmed)) return false;
      return !METADATA_PATTERNS.some((p) => p.test(trimmed));
    });
    let text = kept.join("\n").replace(/\n{2,}$/g, "\n");
    if (!text.trim()) continue;
    cleaned.push({ type: entry.type, text });
  }
  return cleaned;
}

function collectContextBefore(
  entries: AmendDiffChunk[],
  changeIdx: number,
  maxChars: number,
): string {
  let text = "";
  for (let j = changeIdx - 1; j >= 0; j--) {
    if (entries[j].type !== "equal") break;
    text = entries[j].text + text;
    if (text.length >= maxChars) break;
  }
  if (text.length > maxChars) {
    text = "…" + text.slice(text.length - maxChars);
  }
  return text.trim();
}

function collectContextAfter(
  entries: AmendDiffChunk[],
  startIdx: number,
  maxChars: number,
): string {
  let text = "";
  for (let j = startIdx; j < entries.length; j++) {
    if (entries[j].type !== "equal") break;
    text += entries[j].text;
    if (text.length >= maxChars) break;
  }
  if (text.length > maxChars) {
    text = text.slice(0, maxChars) + "…";
  }
  return text.trim();
}

function collectEqualText(
  entries: AmendDiffChunk[],
  startIdx: number,
  endIdx: number,
): string {
  let text = "";
  for (let j = startIdx; j < endIdx; j++) {
    if (entries[j].type === "equal") text += entries[j].text;
    else break;
  }
  return text;
}

/**
 * Group a diff into change regions for rendering.
 *
 * Each group is `[context-before] [changes…] [context-after]`. Adjacent
 * change entries (and small equal gaps under MAX_INLINE_GAP_CHARS) collapse
 * into a single group so the reader doesn't see the same surrounding sentence
 * repeated three times.
 */
export function buildDiffGroups(diff: AmendDiffChunk[]): DiffGroup[] {
  const filtered = filterMetadata(diff);
  if (filtered.length === 0) return [];

  const groups: DiffGroup[] = [];
  let i = 0;

  while (i < filtered.length) {
    if (filtered[i].type === "equal") {
      i++;
      continue;
    }

    const before = collectContextBefore(filtered, i, CONTEXT_CHARS);
    const changes: AmendDiffChunk[] = [];

    while (i < filtered.length) {
      if (filtered[i].type !== "equal") {
        changes.push(filtered[i]);
        i++;
        continue;
      }
      // Look ahead for the next non-equal entry to decide whether this
      // equal gap is small enough to inline into the current group.
      const nextChangeIdx = filtered.findIndex(
        (e, j) => j > i && e.type !== "equal",
      );
      const endIdx = nextChangeIdx === -1 ? filtered.length : nextChangeIdx;
      const gapText = collectEqualText(filtered, i, endIdx);
      if (nextChangeIdx !== -1 && gapText.length < MAX_INLINE_GAP_CHARS) {
        changes.push({ type: "equal", text: gapText });
        i = nextChangeIdx;
      } else {
        break;
      }
    }

    const after = collectContextAfter(filtered, i, CONTEXT_CHARS);
    groups.push({ before, changes, after });
  }

  return groups;
}

/** Convenience flag for the empty-state in the diff sheet. */
export function diffHasChanges(diff: AmendDiffChunk[]): boolean {
  if (!diff || diff.length === 0) return false;
  return diff.some(
    (chunk: { type: AmendDiffChunkType }) =>
      chunk.type === "insert" || chunk.type === "delete",
  );
}
