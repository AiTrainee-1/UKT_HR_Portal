import { CalendarDays, ClipboardCheck, Clock, Fingerprint, LogOut, MapPin, Sun, type LucideIcon } from "lucide-react";
import type { ApprovalSummaryItem } from "@/lib/api-client/custom-hooks";

// What a Department Head (HOD) may decide. Each switch is a DepartmentManager.can_approve_* flag on the server; the
// approval pipelines (Approval Workflow Control) then decide whether an HOD has a step in that kind of request at all,
// so the picker reads them to say so next to the switch.

export type PermKey =
  | "canApproveLeaves"
  | "canApprovePermissions"
  | "canApproveCasualLeave"
  | "canApproveAttendance"
  | "canApproveMissingPunch"
  | "canApproveOnDuty"
  | "canApproveResignations";

export type PermissionValues = Record<PermKey, boolean>;

export type PermissionDef = {
  key: PermKey;
  /** The name on the card. */
  title: string;
  /** The name on a compact chip. */
  short: string;
  description: string;
  /** The approval workflows (keys of /api/approval-summary) this switch lets an HOD act on. */
  workflows: string[];
  icon: LucideIcon;
};

export const PERMISSIONS: PermissionDef[] = [
  {
    key: "canApproveLeaves",
    title: "Leave",
    short: "Leave",
    description: "Full-day and half-day leave requests.",
    workflows: ["leave"],
    icon: CalendarDays,
  },
  {
    key: "canApprovePermissions",
    title: "Permissions & Outpass",
    short: "Permissions",
    description: "Late-in, early-out and one-hour permissions, and gate outpasses.",
    workflows: ["permission", "outpass"],
    icon: Clock,
  },
  {
    key: "canApproveCasualLeave",
    title: "Casual leave",
    short: "Casual leave",
    description: "The one paid casual-leave day staff can ask for.",
    workflows: ["casual_leave"],
    icon: Sun,
  },
  {
    key: "canApproveAttendance",
    title: "Attendance edits",
    short: "Attendance",
    description: "Corrections HR proposes to a day's attendance.",
    workflows: ["attendance_correction"],
    icon: ClipboardCheck,
  },
  {
    key: "canApproveMissingPunch",
    title: "Missing punch",
    short: "Missing punch",
    description: "An employee says they forgot to punch.",
    workflows: ["missing_punch"],
    icon: Fingerprint,
  },
  {
    key: "canApproveOnDuty",
    title: "On-Duty (geo punch)",
    short: "On-Duty",
    description: "Employees working away from the branch.",
    workflows: ["on_duty"],
    icon: MapPin,
  },
  {
    key: "canApproveResignations",
    title: "Resignations",
    short: "Resignations",
    description: "Resignation letters from staff.",
    workflows: ["resignation"],
    icon: LogOut,
  },
];

export const PERM_KEYS: PermKey[] = PERMISSIONS.map((p) => p.key);

export const allPermissions = (on: boolean): PermissionValues =>
  Object.fromEntries(PERM_KEYS.map((k) => [k, on])) as PermissionValues;

/** The switches of an HOD as the server sent them. An older server does not send canApproveMissingPunch: it is on. */
export function permissionValuesOf(manager: Partial<Record<PermKey, boolean>>): PermissionValues {
  return Object.fromEntries(PERM_KEYS.map((k) => [k, manager[k] !== false])) as PermissionValues;
}

export const enabledCount = (values: PermissionValues): number => PERM_KEYS.filter((k) => values[k]).length;

export const enabledPermissions = (values: PermissionValues): PermissionDef[] =>
  PERMISSIONS.filter((p) => values[p.key]);

export const disabledPermissions = (values: PermissionValues): PermissionDef[] =>
  PERMISSIONS.filter((p) => !values[p.key]);

export type PipelineTone = "ok" | "warn" | "off";

export type PipelineNote = { tone: PipelineTone; text: string };

const hasHodStep = (item: ApprovalSummaryItem) => item.steps.some((s) => s.roles.includes("hod"));

/** What the approval pipelines mean for this switch: the path a request takes, a warning when an HOD has no step in it
 *  (the switch changes nothing), or that the approval is switched off. null while the pipelines are not loaded. */
export function pipelineNote(
  summary: Record<string, ApprovalSummaryItem> | undefined,
  perm: PermissionDef,
): PipelineNote | null {
  if (!summary) return null;
  const items = perm.workflows.map((w) => summary[w]).filter((i): i is ApprovalSummaryItem => !!i);
  if (items.length === 0) return null;

  const live = items.filter((i) => i.enabled);
  if (live.length === 0)
    return { tone: "off", text: "Switched off in Approval Workflow Control: new requests are refused." };

  if (!live.some(hasHodStep)) {
    return {
      tone: "warn",
      text: `The HOD has no step in this pipeline (${live[0].path}), so this switch changes nothing right now.`,
    };
  }
  const paths = [...new Set(live.map((i) => i.path))];
  const text = paths.length === 1 ? paths[0] : live.map((i) => `${i.label}: ${i.path}`).join(" · ");
  return { tone: "ok", text };
}
