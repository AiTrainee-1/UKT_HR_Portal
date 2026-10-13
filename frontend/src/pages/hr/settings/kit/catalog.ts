import type { ComponentType } from "react";

/**
 * One searchable setting. Every tab exports a list of these (`<tab>.meta.ts`): the page's search runs over them, and the
 * `id` is the anchor the search jumps to (a `SettingBlock id="..."`). Keep `title` and `purpose` the same words the
 * block shows.
 */
export type SettingMeta = {
  /** Anchor id of the SettingBlock; unique within its tab. */
  id: string;
  /** Tab id as in SETTINGS_TABS ("attendance"). */
  tab: string;
  /** The section (card) heading it sits under. */
  section: string;
  title: string;
  purpose: string;
  /** Other words someone might type to look for it ("late", "grace", "pf"). */
  keywords?: string[];
};

export type SettingsGroupId = "organisation" | "time" | "pay" | "documents" | "system";

export const SETTINGS_GROUPS: { id: SettingsGroupId; label: string; hint: string }[] = [
  { id: "organisation", label: "Organisation", hint: "Who the company is, who to contact, how the portal looks" },
  { id: "time", label: "Attendance & time", hint: "How punches become Present, Late or Half Day" },
  { id: "pay", label: "Pay", hint: "How salary is worked out and shown" },
  { id: "documents", label: "Documents & cards", hint: "Letters, ID cards and what is printed on them" },
  { id: "system", label: "Messages & data", hint: "Email, WhatsApp and backups" },
];

export type SettingsTabDef = {
  /** Tab id; also the key of SETTINGS_TAB_MODULE (permission) and the `?tab=` of the page address. */
  id: string;
  label: string;
  group: SettingsGroupId;
  icon: ComponentType<{ size?: number; className?: string }>;
  /** One sentence: what this tab is for (shown at the top of the tab and in the navigation tooltip). */
  purpose: string;
  /** Where the tab's controls apply: shown as chips under the heading. */
  usedBy: { label: string; to?: string }[];
};

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** A setting matches when every typed word starts a word of its title, purpose, section, tab name or keywords. */
export function searchSettings(metas: SettingMeta[], tabs: SettingsTabDef[], query: string, limit = 12): SettingMeta[] {
  const typed = words(query);
  if (typed.length === 0) return [];
  const tabLabel = new Map(tabs.map((t) => [t.id, t.label]));
  const scored: { meta: SettingMeta; score: number }[] = [];
  for (const meta of metas) {
    const title = words(meta.title);
    const rest = words([meta.section, meta.purpose, tabLabel.get(meta.tab) ?? "", ...(meta.keywords ?? [])].join(" "));
    let score = 0;
    let ok = true;
    for (const w of typed) {
      if (title.some((t) => t.startsWith(w))) score += 3;
      else if (rest.some((t) => t.startsWith(w))) score += 1;
      else {
        ok = false;
        break;
      }
    }
    if (ok) scored.push({ meta, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.meta.title.localeCompare(b.meta.title))
    .slice(0, limit)
    .map((s) => s.meta);
}
