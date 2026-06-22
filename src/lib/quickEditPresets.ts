/**
 * Predefined Smart Edit instructions — mirrors the web "Quick Edits" shortcuts.
 * Each preset maps to a natural-language instruction sent to the amend API.
 */

export interface QuickEditAction {
  id: string;
  label: string;
  icon: string;
  instruction: string;
}

export interface QuickEditAccordion {
  id: string;
  label: string;
  icon: string;
  /** Static options shown when expanded (e.g. template choices). */
  options?: QuickEditAction[];
  /** When true, options are built from note section headings at runtime. */
  useNoteSections?: boolean;
  /** Build an instruction for a section-scoped action. */
  sectionInstruction?: (section: string) => string;
}

/** Top-row one-tap actions. */
export const QUICK_EDIT_ACTIONS: QuickEditAction[] = [
  {
    id: "more_detailed",
    label: "More Detailed",
    icon: "expand-outline",
    instruction: "Make this note more detailed and comprehensive.",
  },
  {
    id: "add_addendum",
    label: "Add Addendum",
    icon: "document-attach-outline",
    instruction: "Add an addendum to this note.",
  },
];

/** Expandable quick-edit groups (Switch Template, Paragraphs, etc.). */
export const QUICK_EDIT_ACCORDIONS: QuickEditAccordion[] = [
  {
    id: "switch_template",
    label: "Switch Template",
    icon: "swap-horizontal-outline",
    options: [
      {
        id: "template_followup",
        label: "Follow-up",
        icon: "calendar-outline",
        instruction: "Switch this note to a follow-up visit template.",
      },
      {
        id: "template_initial",
        label: "Initial Evaluation",
        icon: "clipboard-outline",
        instruction: "Switch this note to an initial evaluation template.",
      },
    ],
  },
  {
    id: "paragraphs",
    label: "Paragraphs",
    icon: "text-outline",
    useNoteSections: true,
    sectionInstruction: (section) =>
      `Rewrite the "${section}" section as paragraphs.`,
  },
  {
    id: "numbered_list",
    label: "Numbered List",
    icon: "list-outline",
    useNoteSections: true,
    sectionInstruction: (section) =>
      `Rewrite the "${section}" section as a numbered list.`,
  },
  {
    id: "remove_section",
    label: "Remove Section",
    icon: "remove-circle-outline",
    useNoteSections: true,
    sectionInstruction: (section) =>
      `Remove the "${section}" section from this note.`,
  },
];

const FALLBACK_SECTIONS = [
  "Chief Complaint",
  "History of Present Illness",
  "Review of Systems",
  "Physical Examination",
  "Assessment",
  "Plan",
];

/** Pull section headings from note markdown for section-scoped quick edits. */
export function extractNoteSections(note: string | null | undefined): string[] {
  if (!note?.trim()) return [...FALLBACK_SECTIONS];

  const sections: string[] = [];
  const seen = new Set<string>();

  const add = (raw: string) => {
    const name = raw.replace(/\*+/g, "").trim();
    if (!name || seen.has(name.toLowerCase())) return;
    seen.add(name.toLowerCase());
    sections.push(name);
  };

  for (const line of note.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const heading = trimmed.match(/^#{1,4}\s+\*?\*?(.+?)\*?\*?\s*$/);
    if (heading) {
      add(heading[1]);
      continue;
    }

    const bold = trimmed.match(/^\*\*(.+?)\*\*:?\s*$/);
    if (bold) {
      add(bold[1]);
      continue;
    }

    const plain = trimmed.match(/^([A-Z][A-Za-z0-9\s/&'()-]{2,48}):\s*$/);
    if (plain) {
      add(plain[1]);
    }
  }

  return sections.length > 0 ? sections : [...FALLBACK_SECTIONS];
}
