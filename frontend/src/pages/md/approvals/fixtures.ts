// Test data of the HOD approvals page (the shapes of api/md_portal/hod_approvals.py).
import type { ApprovalItem, Hod, HodRequestsResponse, HodsResponse } from "./types";

const ALL_RIGHTS: Hod["rights"] = {
  leave: true,
  casual_leave: true,
  permission: true,
  outpass: true,
  missing_punch: true,
  on_duty: true,
  attendance_correction: true,
  holiday_work: true,
  resignation: true,
};

export const hod = (over: Partial<Hod> = {}): Hod => ({
  id: 5,
  employeeId: 93,
  code: "2671",
  name: "Sandhya Krishnan",
  designation: "Executive Assistant",
  department: "MD",
  branch: "Head Office",
  employeeStatus: "active",
  oversees: { departments: ["Stitching"], people: 12 },
  rights: ALL_RIGHTS,
  pending: { leave: 1, permission: 1, other: 1, total: 3 },
  ...over,
});

export const HODS: HodsResponse = {
  hods: [
    hod(),
    hod({
      id: 8,
      employeeId: 94,
      code: "2700",
      name: "Ravi Kumar",
      pending: { leave: 0, permission: 0, other: 0, total: 0 },
      rights: { ...ALL_RIGHTS, missing_punch: false },
    }),
  ],
  mdDepartments: [{ id: 44, name: "MD", branch: "Head Office" }],
};

const step = (state: string, roles = ["hod"], by: string | null = null) => ({
  label: null,
  roles,
  state,
  by,
  at: by ? "2026-11-12T10:00:00" : null,
  comment: null,
});

export const item = (over: Partial<ApprovalItem> = {}): ApprovalItem => ({
  key: "leave-14",
  kind: "leave",
  kindLabel: "Leave",
  group: "leave",
  id: 14,
  employee: { id: 71, code: "30020", name: "Surya M", department: "Stitching", designation: "Tailor" },
  title: "Sick Leave",
  from: "2026-11-12",
  to: "2026-11-13",
  detail: "2 days",
  reason: "Fever",
  status: "pending",
  state: "pending",
  statusLabel: "Waiting for the Department Head",
  submittedAt: "2026-11-11T04:22:56Z",
  decidedBy: null,
  decidedAt: null,
  steps: [step("pending"), step("waiting", ["hr"])],
  waitingFor: ["hod"],
  canApprove: true,
  canReject: true,
  blockedReason: null,
  ...over,
});

export const PENDING: HodRequestsResponse = {
  hod: hod(),
  status: "pending",
  items: [
    item(),
    item({
      key: "permission-48",
      kind: "permission",
      kindLabel: "Permission",
      group: "permission",
      id: 48,
      title: "Permission · Evening Early-Out",
      from: "2026-11-13",
      to: null,
      detail: "17:00",
      reason: "Bank work",
    }),
    item({
      key: "resignation-3",
      kind: "resignation",
      kindLabel: "Resignation",
      group: "other",
      id: 3,
      title: "Resignation",
      from: "2026-11-10",
      to: null,
      detail: "Last working day 2026-12-10",
      reason: "Moving away",
      steps: [step("pending")],
    }),
  ],
  counts: { leave: 1, permission: 1, other: 1, total: 3 },
};
