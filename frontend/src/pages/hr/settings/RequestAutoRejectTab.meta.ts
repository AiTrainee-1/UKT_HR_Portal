import type { SettingMeta } from "./kit/catalog";

const tab = "request_auto_reject";
const RULE = "Automatic rejection";
const DUE = "Due at the next run";
const HISTORY = "Rejected automatically";

const WORDS = [
  "auto reject",
  "automatic",
  "reject",
  "pending",
  "waiting",
  "old requests",
  "undecided",
  "expire",
  "stale",
];

/** Every setting on the Auto-Reject Requests tab, for the page's search (see kit/catalog.ts). */
export const REQUEST_AUTO_REJECT_SETTINGS: SettingMeta[] = [
  {
    id: "ar-switch",
    tab,
    section: RULE,
    title: "Reject waiting requests automatically",
    purpose:
      "On: every night at 01:30, requests nobody decided within the number of days below of being submitted are rejected. Resignations are never rejected automatically.",
    keywords: [...WORDS, "switch", "on", "off", "nightly", "leave", "permission", "missing punch", "on-duty"],
  },
  {
    id: "ar-days",
    tab,
    section: RULE,
    title: "Days a request may wait",
    purpose: "How many days after the day it was submitted a request may wait for a decision before it is rejected.",
    keywords: [...WORDS, "days", "45", "age", "older than", "limit"],
  },
  {
    id: "ar-due",
    tab,
    section: DUE,
    title: "Due at the next run and Run now",
    purpose: "The requests the next run would reject, and the button that rejects them at once.",
    keywords: [...WORDS, "run now", "preview", "due", "tonight", "backlog"],
  },
  {
    id: "ar-history",
    tab,
    section: HISTORY,
    title: "Requests rejected automatically",
    purpose:
      "Every request the automatic rejection rejected: whose, what was asked, when it was submitted and by which run.",
    keywords: [...WORDS, "history", "log", "rejected", "audit"],
  },
];
