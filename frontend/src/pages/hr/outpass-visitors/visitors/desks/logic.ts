// Manage Reception: the pure parts (no React): the shared desk sign-in address, the permission keys, the address keys of
// the page, the records query the table asks for and the summary line. The generic pieces (suggested passwords, the
// username / password rules, "online now", copying, the server's error words) are Manage Gates' own, imported.

import type { ReceptionRecordCounts, ReceptionRecordType } from "@/lib/api-client/custom-hooks";
import { fmtCount, resolveDateRange } from "../../kit";

export {
  copyText,
  errorText,
  generatePassword,
  isNotStored,
  isOnline,
  passwordProblem,
  readSelection,
  STATUS_OPTIONS,
  usernameProblem,
  type GateSelection as DeskSelection,
} from "../../gates/logic";

/** Every reception desk signs in at this one address; the username and password decide which desk it is. */
export const DESK_SIGN_IN_PATH = "/reception-login";

export const deskSignInAddress = (origin: string): string => `${origin.replace(/\/+$/, "")}${DESK_SIGN_IN_PATH}`;

/** The permission keys of the page: the tab, the desks (view = look, edit = change) and "See desk passwords". */
export const DESKS_TAB_KEY = "outpass_visitors.visitors.desks";
export const DESKS_KEY = "outpass_visitors.visitors.reception_devices";
export const DESK_PASSWORD_KEY = "outpass_visitors.visitors.reception_devices.view_password";

/**
 * The address keys of Manage Reception (module-level: useUrlParams needs a stable object). They differ from the Visitors
 * tab's own (range, from, to, q, status, page ...), so a trip between the two tabs (the strip carries the query along) never
 * filters one with the other's values. `desk` / `deskQ` / `deskStatus`: which desk is open, the desk list's search and
 * status. `rec*`: the records card's filters and paging.
 */
export const DESK_PAGE_DEFAULTS = {
  desk: "",
  deskQ: "",
  deskStatus: "",
  recRange: "month",
  recFrom: "",
  recTo: "",
  recType: "",
  recQ: "",
  recDesk: "",
  recPage: "1",
  recSize: "25",
};
export type DeskPageValues = typeof DESK_PAGE_DEFAULTS;

/** The records card's own keys (Clear resets these, and only these). */
export const RECORD_KEYS = ["recRange", "recFrom", "recTo", "recType", "recQ", "recDesk"] as const;

/** How many record filters differ from their defaults (the date filter counts once). */
export function recordFilterCount(values: DeskPageValues): number {
  const dates = ["recRange", "recFrom", "recTo"].some(
    (k) => values[k as keyof DeskPageValues] !== DESK_PAGE_DEFAULTS[k as keyof DeskPageValues],
  );
  const others = (["recType", "recQ", "recDesk"] as const).filter((k) => values[k] !== DESK_PAGE_DEFAULTS[k]).length;
  return (dates ? 1 : 0) + others;
}

/**
 * The records list's query: from / to worked out from the date filter (India), type, q, and `deskId` = the chosen desk, or
 * (for "All desks") the Desk filter when one is picked; with `paging`, page and pageSize too (never in an export).
 */
export function recordsQuery(
  values: DeskPageValues,
  selection: number | "all",
  { paging = true, now = new Date() }: { paging?: boolean; now?: Date } = {},
): URLSearchParams {
  const out = new URLSearchParams();
  if (selection === "all") {
    if (values.recDesk) out.set("deskId", values.recDesk);
  } else {
    out.set("deskId", String(selection));
  }
  const { from, to } = resolveDateRange({ range: values.recRange, from: values.recFrom, to: values.recTo }, now);
  if (from) out.set("from", from);
  if (to) out.set("to", to);
  if (values.recType) out.set("type", values.recType);
  if (values.recQ) out.set("q", values.recQ);
  if (paging) {
    out.set("page", String(Math.max(1, Number(values.recPage) || 1)));
    out.set("pageSize", values.recSize || DESK_PAGE_DEFAULTS.recSize);
  }
  return out;
}

/** "4 records · 2 check-ins · 2 check-outs" (the counts cover both types). */
export function recordsSummary(total: number, counts: ReceptionRecordCounts | undefined): string {
  const parts = [`${fmtCount(total)} ${total === 1 ? "record" : "records"}`];
  if (counts) {
    parts.push(`${fmtCount(counts.checkIns)} ${counts.checkIns === 1 ? "check-in" : "check-ins"}`);
    parts.push(`${fmtCount(counts.checkOuts)} ${counts.checkOuts === 1 ? "check-out" : "check-outs"}`);
  }
  return parts.join(" · ");
}

export const TYPE_OPTIONS: readonly { value: ReceptionRecordType; label: string }[] = [
  { value: "check_in", label: "Check-in" },
  { value: "check_out", label: "Check-out" },
];
