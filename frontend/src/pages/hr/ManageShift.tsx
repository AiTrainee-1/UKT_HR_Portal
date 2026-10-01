import { useMemo, useState, type ReactNode } from "react";
import { CalendarClock, Layers, Plus, UserMinus, Users } from "lucide-react";
import HrLayout from "@/components/HrLayout";
import { RefreshButton } from "@/components/PageRefreshBar";
import { Button } from "@/components/ui/button";
import { PillTabs } from "@/components/ui/pill-tabs";
import { useListEmployees } from "@/lib/api-client";
import {
  useListShiftAssignments,
  useShiftTemplates,
  type ShiftAssignment,
  type ShiftItem,
  type ShiftType,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import AssignDialog, { type AssignDialogStart } from "./shifts/AssignDialog";
import AssignmentsTab from "./shifts/AssignmentsTab";
import ShiftFormDialog from "./shifts/ShiftFormDialog";
import ShiftsTab from "./shifts/ShiftsTab";
import UnassignedTab from "./shifts/UnassignedTab";
import { unassignedOf, type Person } from "./shifts/shift-logic";

type Tab = "shifts" | "assignments" | "unassigned";

function StatTile({
  icon,
  tint,
  value,
  label,
  sub,
  testId,
  onClick,
}: {
  icon: ReactNode;
  tint: string;
  value: number;
  label: string;
  sub?: string;
  testId: string;
  onClick?: () => void;
}) {
  const body = (
    <>
      <span className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl", tint)}>{icon}</span>
      <span className="min-w-0 text-left">
        <span className="block text-2xl font-black leading-none text-gray-900">{value}</span>
        <span className="mt-1 block text-xs font-medium leading-tight text-gray-500">{label}</span>
        {sub && <span className="block text-[11px] leading-tight text-gray-400">{sub}</span>}
      </span>
    </>
  );
  const cls = "flex items-center gap-3 rounded-2xl bg-white p-4 shadow-sm";
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      className={cn(cls, "transition-shadow hover:shadow-md")}
      data-testid={testId}
    >
      {body}
    </button>
  ) : (
    <div className={cls} data-testid={testId}>
      {body}
    </div>
  );
}

/**
 * Manage Shifts: the shift templates (Shifts), who is on which shift (Assignments) and who is on none (Unassigned).
 * Assigning is one dialog everywhere (a shift's own card, a group, the unassigned list): pick the shift and date, include
 * or exclude employees, departments and designations, and read the preview before anything is saved.
 */
export default function ManageShift() {
  const [tab, setTab] = useState<Tab>("shifts");
  const [form, setForm] = useState<{ editing: ShiftItem | null; type: ShiftType } | null>(null);
  const [assign, setAssign] = useState<AssignDialogStart | null>(null);
  const [focusShiftId, setFocusShiftId] = useState<number | null>(null);

  const { data: shifts = [], isLoading } = useShiftTemplates();
  const { data: assignments = [] } = useListShiftAssignments({ activeOnly: true });
  const { data: employees = [] } = useListEmployees({ status: "active" });

  const without = useMemo(() => unassignedOf<Person>(employees, assignments).length, [employees, assignments]);
  const unused = shifts.filter((s) => s.isActive && !(s.assignedCount ?? 0)).length;
  const staff = shifts.filter((s) => s.shiftType === "staff").length;

  const assignShift = (s: ShiftItem) =>
    setAssign({ shiftId: s.id, lockShift: true, includeAll: s.shiftType === "production" });
  const viewPeople = (s: ShiftItem) => {
    setFocusShiftId(null);
    setTab("assignments");
    setTimeout(() => setFocusShiftId(s.id), 0);
  };
  const moveAway = (people: ShiftAssignment[]) =>
    setAssign({
      employees: people.map((p) => ({ id: p.employeeId, label: p.employeeName, sub: p.employeeCode })),
      onConflict: "reassign",
    });
  const assignPeople = (people: Person[]) =>
    setAssign({
      employees: people.map((p) => ({
        id: p.id,
        label: `${p.firstName} ${p.lastName ?? ""}`.trim(),
        sub: p.employeeCode,
      })),
    });

  return (
    <HrLayout>
      <div className="space-y-5 pb-10" data-testid="manage-shift">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-2xl font-black text-gray-900">Manage Shifts</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Create shifts and choose who works them. Attendance and payroll follow the shift each person is on.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <RefreshButton />
            <Button className="gap-2" onClick={() => setForm({ editing: null, type: "staff" })} data-testid="new-shift">
              <Plus size={16} /> New Shift
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            testId="stat-shifts"
            icon={<Layers size={18} />}
            tint="bg-blue-50 text-blue-600"
            value={shifts.length}
            label="Shifts"
            sub={`${staff} staff · ${shifts.length - staff} production`}
          />
          <StatTile
            testId="stat-assigned"
            icon={<Users size={18} />}
            tint="bg-emerald-50 text-emerald-600"
            value={assignments.length}
            label="Employees on a shift"
            onClick={() => setTab("assignments")}
          />
          <StatTile
            testId="stat-unassigned"
            icon={<UserMinus size={18} />}
            tint={without > 0 ? "bg-red-50 text-red-600" : "bg-gray-50 text-gray-400"}
            value={without}
            label="Without a shift"
            sub={without > 0 ? "Open the list to assign them" : "Everyone is covered"}
            onClick={() => setTab("unassigned")}
          />
          <StatTile
            testId="stat-unused"
            icon={<CalendarClock size={18} />}
            tint="bg-amber-50 text-amber-600"
            value={unused}
            label="Shifts nobody is on"
          />
        </div>

        <PillTabs
          items={[
            { value: "shifts", label: "Shifts", count: shifts.length, icon: <Layers size={13} /> },
            {
              value: "assignments",
              label: (
                <>
                  <span className="hidden sm:inline">Assignments</span>
                  <span className="sm:hidden">Assigned</span>
                </>
              ),
              count: assignments.length,
              icon: <Users size={13} />,
            },
            {
              value: "unassigned",
              label: "Unassigned",
              count: without,
              icon: <UserMinus size={13} />,
              color: "#dc2626",
            },
          ]}
          value={tab}
          onChange={(v) => setTab(v as Tab)}
        />

        {tab === "shifts" && (
          <ShiftsTab
            shifts={shifts}
            loading={isLoading}
            onCreate={(type) => setForm({ editing: null, type })}
            onEdit={(s) => setForm({ editing: s, type: s.shiftType })}
            onAssign={assignShift}
            onViewPeople={viewPeople}
          />
        )}
        {tab === "assignments" && (
          <AssignmentsTab
            focusShiftId={focusShiftId}
            onAssignToShift={(id) => {
              const s = shifts.find((x) => x.id === id);
              if (s) assignShift(s);
            }}
            onMove={moveAway}
          />
        )}
        {tab === "unassigned" && <UnassignedTab onAssign={assignPeople} />}

        {form && (
          <ShiftFormDialog
            key={form.editing?.id ?? "new"}
            open
            onClose={() => setForm(null)}
            editing={form.editing}
            defaultType={form.type}
            shifts={shifts}
          />
        )}
        {assign && <AssignDialog open onClose={() => setAssign(null)} shifts={shifts} start={assign} />}
      </div>
    </HrLayout>
  );
}
