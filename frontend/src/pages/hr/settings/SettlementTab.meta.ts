import type { SettingMeta } from "./kit/catalog";

/** The tab's one row of sub-tabs (owner 2026-11-27): the two methods and the two sets of rules, side by side. */
export type SettlementSubTab = "normal" | "automation" | "sa_rules" | "tl_rules";

const tab = "settlement";
const METHOD = "Loan & Advance method";
const EMAILS = "Where the files go";
const SA_RULES = "Salary Advance rules";
const TL_RULES = "Term Loan rules";

const WORDS = [
  "loan & advance",
  "loan and advance",
  "settlement",
  "salary advance",
  "term loan",
  "advance",
  "loan",
  "method",
  "workflow",
];

type SettlementSettingMeta = SettingMeta & { subTab: SettlementSubTab };

const BLOCKS: SettlementSettingMeta[] = [
  {
    id: "sl-normal",
    tab,
    subTab: "normal",
    section: METHOD,
    title: "Normal Method",
    purpose:
      "Loan & Advance as it has always been: HR approves or rejects each Salary Advance and Term Loan on its own, whenever it comes in.",
    keywords: [...WORDS, "normal", "approve", "reject", "one by one", "manual"],
  },
  {
    id: "sl-automation",
    tab,
    subTab: "automation",
    section: METHOD,
    title: "Automation Method",
    purpose:
      "Loan & Advance becomes a month-wise workflow, one for Salary Advances and one for Term Loans: HR reviews the month's requests and forwards them to the MD, the MD approves or rejects each one, HR finalizes within the MD's decisions, the report goes to the auditor and the bank file to Accounts.",
    keywords: [...WORDS, "automation", "automatic", "md approval", "auditor", "accounts", "batch", "monthly"],
  },
  {
    id: "sl-auditor",
    tab,
    subTab: "automation",
    section: EMAILS,
    title: "Auditor e-mail addresses",
    purpose:
      "Who gets the secure review link to the Auditor Review Portal (with the finalized report attached as PDF and Excel) at Send to Auditor: the To addresses, and any CC addresses.",
    keywords: [...WORDS, "auditor", "email", "e-mail", "mail", "cc", "report", "recipients"],
  },
  {
    id: "sl-accounts",
    tab,
    subTab: "automation",
    section: EMAILS,
    title: "Accounts e-mail addresses",
    purpose: "Who gets the bank file at Send Bank File to Accounts: the To addresses, and any CC addresses.",
    keywords: [...WORDS, "accounts", "bank file", "email", "e-mail", "mail", "cc", "payment", "recipients"],
  },
  {
    id: "sl-link-days",
    tab,
    subTab: "automation",
    section: EMAILS,
    title: "Review link valid for",
    purpose:
      "How many days the auditor's secure review link works (1 to 30, 7 by default). A new Send to Auditor replaces the older link, and a link stops working once the auditor answers.",
    keywords: [...WORDS, "auditor", "review link", "link", "expiry", "expires", "days", "valid", "portal"],
  },
  {
    id: "sl-sa-amount",
    tab,
    subTab: "sa_rules",
    section: SA_RULES,
    title: "How much a Salary Advance can be",
    purpose:
      "The most an employee may ask for, as a share of the salary earned from the 1st of the month up to a day you choose. Applies at once to the apps, HR's New request and the approval screens.",
    keywords: [...WORDS, "salary advance", "percent", "limit", "earned salary", "eligible", "maximum", "day"],
  },
  {
    id: "sl-sa-window",
    tab,
    subTab: "sa_rules",
    section: SA_RULES,
    title: "When employees may apply",
    purpose:
      "The days of the month on which employees can send a Salary Advance request from the apps. HR may raise one on the same days.",
    keywords: [...WORDS, "salary advance", "window", "apply", "days", "from", "to", "dates"],
  },
  {
    id: "sl-sa-count",
    tab,
    subTab: "sa_rules",
    section: SA_RULES,
    title: "How many a month",
    purpose:
      "How many Salary Advances one employee may have in a month, and whether a rejected request still counts against that number.",
    keywords: [...WORDS, "salary advance", "per month", "count", "rejected", "again", "reapply"],
  },
  {
    id: "sl-tl-limit",
    tab,
    subTab: "tl_rules",
    section: TL_RULES,
    title: "How much a Term Loan can be",
    purpose:
      "The most a staff employee may borrow, as a share of the fixed monthly salary. Going above the monthly salary needs its own switch.",
    keywords: [...WORDS, "term loan", "limit", "percent", "monthly salary", "above salary", "maximum"],
  },
  {
    id: "sl-tl-repay",
    tab,
    subTab: "tl_rules",
    section: TL_RULES,
    title: "Repayment and the smallest loan",
    purpose:
      "The most months a Term Loan may be repaid over (monthly EMIs from the next month's salary) and the smallest amount that can be asked for.",
    keywords: [...WORDS, "term loan", "months", "emi", "repayment", "minimum amount", "smallest"],
  },
  {
    id: "sl-tl-when",
    tab,
    subTab: "tl_rules",
    section: TL_RULES,
    title: "Who may apply, and how often",
    purpose:
      "Service needed before a first Term Loan, how many may be approved in a calendar year, waiting after a rejection, and one open loan at a time.",
    keywords: [...WORDS, "term loan", "service", "per year", "yearly", "rejected", "one at a time", "active", "staff"],
  },
];

/** Every setting on the Loan & Advance tab, for the page's search (see kit/catalog.ts). */
export const SETTLEMENT_SETTINGS: SettingMeta[] = BLOCKS.map(({ subTab: _subTab, ...meta }) => meta);

/** The sub-tab (Normal Method / Automation Method) a setting sits in: a search hit or a #setting link opens it. */
export const SETTLEMENT_SUB_TAB_OF: Record<string, SettlementSubTab> = Object.fromEntries(
  BLOCKS.map((b) => [b.id, b.subTab]),
);
