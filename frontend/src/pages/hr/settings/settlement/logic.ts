// Settings -> Settlement (owner 2026-11-26): the rules behind the tab, kept apart from the screen so they can be tested.
// The server checks every address again (settlement_automation.service.clean_emails); these only tell HR before saving.

import type {
  SettlementInProgress,
  SettlementMethod,
  SettlementSettings,
} from "@/lib/api-client/custom-hooks/settlement-automation";

/** The most addresses one list may hold (service.MAX_EMAILS). */
export const MAX_EMAILS = 10;

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** The words the server splits a typed list on: commas, semicolons, spaces and line breaks. */
export const splitEmails = (text: string): string[] =>
  text
    .split(/[,;\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);

/** What is wrong with one address, or null when it is one. */
export function emailProblem(email: string): string | null {
  const e = email.trim();
  if (!e) return "Type an e-mail address.";
  if (e.length > 254 || !EMAIL.test(e)) return `'${e}' is not an e-mail address.`;
  return null;
}

export type AddResult = {
  /** The list with the good addresses added (lower case, no repeats). */
  list: string[];
  /** The words that were not addresses (they stay in the box for HR to fix). */
  rejected: string[];
  problem: string | null;
};

/** Adds what was typed (one address or several) to a list: good ones in lower case once each, at most MAX_EMAILS. */
export function addEmails(list: readonly string[], typed: string): AddResult {
  const out = [...list];
  const rejected: string[] = [];
  let problem: string | null = null;
  for (const word of splitEmails(typed)) {
    const bad = emailProblem(word);
    if (bad) {
      rejected.push(word);
      problem ??= bad;
      continue;
    }
    const email = word.toLowerCase();
    if (out.includes(email)) continue;
    if (out.length >= MAX_EMAILS) {
      rejected.push(word);
      problem ??= `At most ${MAX_EMAILS} addresses.`;
      continue;
    }
    out.push(email);
  }
  return { list: out, rejected, problem };
}

export const removeEmail = (list: readonly string[], email: string): string[] => list.filter((e) => e !== email);

export const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((e, i) => e === b[i]);

/** The four lists the tab edits. */
export type EmailForm = {
  auditorEmails: string[];
  auditorCc: string[];
  accountsEmails: string[];
  accountsCc: string[];
};
export type EmailField = keyof EmailForm;

export const EMAIL_FIELDS: readonly EmailField[] = ["auditorEmails", "auditorCc", "accountsEmails", "accountsCc"];

export const emailFormOf = (s: SettlementSettings | undefined): EmailForm => ({
  auditorEmails: s?.auditorEmails ?? [],
  auditorCc: s?.auditorCc ?? [],
  accountsEmails: s?.accountsEmails ?? [],
  accountsCc: s?.accountsCc ?? [],
});

/** The lists that differ from the saved ones (what Save sends). */
export function changedEmails(saved: EmailForm, form: EmailForm): Partial<EmailForm> {
  const out: Partial<EmailForm> = {};
  for (const f of EMAIL_FIELDS) if (!sameList(saved[f], form[f])) out[f] = form[f];
  return out;
}

/** A CC list without a To list is never e-mailed: the To address is the one the e-mail is sent to. */
export function ccWithoutTo(form: EmailForm): string | null {
  if (form.auditorCc.length > 0 && form.auditorEmails.length === 0)
    return "Add an auditor To address: the CC addresses only get a copy.";
  if (form.accountsCc.length > 0 && form.accountsEmails.length === 0)
    return "Add an Accounts To address: the CC addresses only get a copy.";
  return null;
}

export const METHOD_LABEL: Record<SettlementMethod, string> = {
  normal: "Normal Method",
  automation: "Automation Method",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Salary Advance · Batch 1 of Nov 2026: HR Final Settlement" (the type since 2026-11-27: each runs its own batches). */
export const inProgressText = (b: SettlementInProgress): string =>
  `${b.typeLabel ? `${b.typeLabel} · ` : ""}Batch ${b.number} of ${MONTHS[b.month - 1] ?? "?"} ${b.year}: ${b.stageLabel}`;

// ─── How long the auditor's review link works (2026-11-27) ──────────────────────

export type LinkDaysLimits = { min: number; max: number; default: number };
export const LINK_DAYS_LIMITS: LinkDaysLimits = { min: 1, max: 30, default: 7 };

/** What is wrong with the typed number of days, or null when it can be saved (service.LINK_DAYS_MIN / MAX). */
export function linkDaysProblem(text: string, limits: LinkDaysLimits = LINK_DAYS_LIMITS): string | null {
  const t = text.trim();
  const n = Number(t);
  if (t === "" || !Number.isInteger(n) || n < limits.min || n > limits.max)
    return `Enter whole days from ${limits.min} to ${limits.max}.`;
  return null;
}
