import type { ComponentType } from "react";
import {
  AlarmClock,
  AlertTriangle,
  Banknote,
  BedDouble,
  CalendarX2,
  CircleSlash,
  Clock,
  FileWarning,
  Fingerprint,
  Gauge,
  Hourglass,
  Landmark,
  LogOut,
  Scale,
  ShieldAlert,
  Timer,
  TimerOff,
  UserX,
  Wallet,
} from "lucide-react";
import type { IssueCategory, IssueCode, IssueSeverity } from "@/lib/api-client/custom-hooks";
import type { Tone } from "@/lib/statusTones";

type IconType = ComponentType<{ size?: number; className?: string }>;

/** How a severity looks everywhere (chips, dots, row accents). */
export const SEVERITY_META: Record<IssueSeverity, { label: string; tone: Tone; dot: string; rank: number }> = {
  critical: { label: "Critical", tone: "danger", dot: "bg-red-500", rank: 0 },
  warning: { label: "Needs a look", tone: "warning", dot: "bg-amber-500", rank: 1 },
  info: { label: "For information", tone: "info", dot: "bg-sky-500", rank: 2 },
};

export const CATEGORY_LABEL: Record<IssueCategory, string> = {
  attendance: "Attendance",
  pay: "Pay & deductions",
  profile: "Employee profile",
  rule: "Rules",
  generation: "Payroll generation",
};

/**
 * What each issue code is called and drawn as. The server sends its own titles and severities with every issue; this
 * is the fallback for a filter list that has to name a code with no issues yet, and where the icon / category come from.
 */
export const ISSUE_META: Record<
  IssueCode,
  { label: string; icon: IconType; category: IssueCategory; severity: IssueSeverity }
> = {
  absent: { label: "Absent", icon: UserX, category: "attendance", severity: "warning" },
  unpaid_leave: { label: "Unpaid leave", icon: CalendarX2, category: "attendance", severity: "warning" },
  late_in: { label: "Late arrival", icon: AlarmClock, category: "attendance", severity: "warning" },
  early_out: { label: "Early leaving", icon: LogOut, category: "attendance", severity: "warning" },
  half_day: { label: "Half day", icon: Hourglass, category: "attendance", severity: "warning" },
  quarter_day: { label: "Quarter-day cut", icon: Gauge, category: "attendance", severity: "warning" },
  missing_punch: { label: "Missing punch", icon: Fingerprint, category: "attendance", severity: "warning" },
  no_attendance: { label: "No attendance", icon: BedDouble, category: "attendance", severity: "critical" },
  no_shift: { label: "No shift assigned", icon: TimerOff, category: "rule", severity: "warning" },
  late_penalty: { label: "Late deduction", icon: Timer, category: "pay", severity: "warning" },
  excess_permission: { label: "Excess permission", icon: ShieldAlert, category: "pay", severity: "warning" },
  advance_recovery: { label: "Advance recovery", icon: Wallet, category: "pay", severity: "info" },
  ot_pay: { label: "Overtime pay", icon: Clock, category: "pay", severity: "info" },
  adjustment: { label: "Manual adjustment", icon: Scale, category: "pay", severity: "info" },
  bank_missing: { label: "Bank details missing", icon: Landmark, category: "profile", severity: "warning" },
  pf_number_missing: { label: "PF number missing", icon: FileWarning, category: "profile", severity: "info" },
  esi_number_missing: { label: "ESI number missing", icon: FileWarning, category: "profile", severity: "info" },
  skipped: { label: "Skipped at generation", icon: CircleSlash, category: "generation", severity: "critical" },
};

export const issueIcon = (code: string): IconType => ISSUE_META[code as IssueCode]?.icon ?? AlertTriangle;
export const issueLabel = (code: string): string => ISSUE_META[code as IssueCode]?.label ?? code.replace(/_/g, " ");

/** The order issues are listed in when nothing else decides: worst first, then by kind. */
export const severityRank = (s: IssueSeverity): number => SEVERITY_META[s]?.rank ?? 9;

export const MONEY_ICON = Banknote;
