// HOD approvals (/md/approvals): what GET /api/md/approvals/hods and GET /api/md/approvals/hods/<id> answer
// (backend api/md_portal/hod_approvals.py).

export type ApprovalKind =
  | "leave"
  | "casual_leave"
  | "permission"
  | "outpass"
  | "missing_punch"
  | "on_duty"
  | "attendance_correction"
  | "holiday_work"
  | "resignation";

export type ApprovalGroup = "leave" | "permission" | "other";
export type RequestStatusFilter = "pending" | "approved" | "rejected" | "all";
export type Decision = "approved" | "rejected";

export type GroupCounts = Record<ApprovalGroup, number> & { total: number };

export type Hod = {
  /** The Department Head record's id (DepartmentManager), used in the addresses. */
  id: number;
  employeeId: number;
  code: string;
  name: string;
  designation: string | null;
  department: string | null;
  branch: string | null;
  employeeStatus: string;
  oversees: { departments: string[]; people: number };
  /** Which kinds this head may decide (the switches HR sets in User Management). */
  rights: Record<ApprovalKind, boolean>;
  /** What this head can decide right now. */
  pending: GroupCounts;
};

export type HodsResponse = {
  hods: Hod[];
  mdDepartments: { id: number; name: string; branch: string | null }[];
};

export type ApprovalStep = {
  label: string | null;
  roles: string[];
  state: "approved" | "rejected" | "pending" | "waiting" | "skipped" | string;
  by: string | null;
  at: string | null;
  comment: string | null;
};

export type ApprovalItem = {
  key: string;
  kind: ApprovalKind;
  kindLabel: string;
  group: ApprovalGroup;
  id: number;
  employee: {
    id: number | null;
    code: string | null;
    name: string | null;
    department: string | null;
    designation: string | null;
  };
  title: string;
  from: string | null;
  to: string | null;
  detail: string | null;
  reason: string | null;
  status: string;
  state: "pending" | "approved" | "rejected" | "cancelled";
  statusLabel: string;
  submittedAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  steps: ApprovalStep[];
  waitingFor: string[];
  canApprove: boolean;
  canReject: boolean;
  blockedReason: string | null;
};

export type HodRequestsResponse = {
  hod: Hod;
  status: RequestStatusFilter;
  items: ApprovalItem[];
  counts: GroupCounts;
};

export type DecideInput = {
  managerId: number;
  kind: ApprovalKind;
  id: number;
  decision: Decision;
  comment?: string;
};

export type DecideResponse = { item: ApprovalItem | null; decision: Decision; actor: string };
