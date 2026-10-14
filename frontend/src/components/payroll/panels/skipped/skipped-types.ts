import type { Tone } from "@/lib/statusTones";

/**
 * One employee payroll could not (or would not) generate for. The staff and production skip checks, the result of a
 * Generate run and the production roster's "blocked" people all map onto this: the page that owns the data converts and
 * hands the list to the panels.
 */
export type SkippedItem = {
  employeeId: number;
  employeeCode: string;
  name: string;
  /** The message the payroll engine gave, word for word ("No Salary Amount set on this employee's profile"). */
  reason: string;
  department?: string | null;
};

/** What kind of problem a skip reason describes (see classifySkipReason for the strings each one comes from). */
export type SkipCategory =
  | "no_salary"
  | "no_rate"
  | "no_working_days"
  | "already_paid"
  | "overlap"
  | "not_production"
  | "inactive"
  | "no_cycle"
  | "wrong_cycle"
  | "other";

/** A real page of the HRMS that helps fix a skip, and the words on the link. */
export type SkipLink = { href: string; label: string };

export type SkipClassification = {
  category: SkipCategory;
  /** The category's short name: "No salary amount". */
  label: string;
  /** What to do about it, in a sentence (specific when the reason carries a date, a month or a cycle). */
  fix: string;
  /** The page that fixes it; an employee-specific one (their profile) when the employee id is known. */
  href?: string;
  hrefLabel?: string;
  /** A second page that helps, when there is one (Holidays, for "no working days"). */
  secondary?: SkipLink;
  /** False for a skip where nothing is wrong ("Already paid"): the employee is not left unpaid by it. */
  blocksPay: boolean;
  tone: Tone;
};
