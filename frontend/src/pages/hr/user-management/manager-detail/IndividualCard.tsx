import { useState } from "react";
import { Plus, UserRound, X } from "lucide-react";
import EmployeeSearchSelect from "@/components/EmployeeSearchSelect";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/status-badge";
import { useToast } from "@/hooks/use-toast";
import { ApiError } from "@/lib/api-client/custom-fetch";
import {
  useAssignEmployeeToManager,
  useRemoveEmployeeFromManager,
  type DepartmentManagerItem,
  type EmployeeAssignmentConflict,
} from "@/lib/api-client/custom-hooks";
import { EmployeeConflictDialog } from "./ConflictDialogs";

type Candidate = { id: number; employeeCode?: string | null; firstName: string; lastName: string };

/**
 * Employees assigned to this HOD one by one, for people outside the departments they cover (a cross-department
 * report). An individual assignment beats department coverage, so it also pulls someone in from another HOD's department.
 */
export default function IndividualCard({
  manager,
  employees,
}: {
  manager: DepartmentManagerItem;
  employees: Candidate[];
}) {
  const { toast } = useToast();
  const assign = useAssignEmployeeToManager();
  const remove = useRemoveEmployeeFromManager();
  const [newEmpId, setNewEmpId] = useState("");
  const [conflict, setConflict] = useState<{
    employeeCode: string;
    employeeName: string;
    conflict: EmployeeAssignmentConflict;
  } | null>(null);

  const assigned = manager.assignedEmployees ?? [];
  const elsewhere = new Map((manager.overlaps ?? []).map((o) => [o.employeeId, o]));

  const add = async () => {
    const emp = employees.find((e) => String(e.id) === newEmpId);
    if (!emp?.employeeCode) return;
    try {
      await assign.mutateAsync({ managerId: manager.id, employeeCode: emp.employeeCode });
      setNewEmpId("");
      toast({ title: `${emp.firstName} ${emp.lastName} assigned` });
    } catch (e) {
      const data = e instanceof ApiError ? (e.data as EmployeeAssignmentConflict | null) : null;
      if (e instanceof ApiError && e.status === 409 && data?.conflict) {
        setConflict({
          employeeCode: emp.employeeCode,
          employeeName: `${emp.firstName} ${emp.lastName}`,
          conflict: data,
        });
        return;
      }
      toast({ title: e instanceof Error ? e.message : "Already assigned", variant: "destructive" });
    }
  };

  const confirmReassign = async () => {
    if (!conflict) return;
    try {
      await assign.mutateAsync({ managerId: manager.id, employeeCode: conflict.employeeCode, force: true });
      setNewEmpId("");
      toast({ title: `${conflict.employeeName} reassigned to this HOD` });
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : "Failed to reassign", variant: "destructive" });
    } finally {
      setConflict(null);
    }
  };

  const claim = async (code: string, name: string) => {
    try {
      await assign.mutateAsync({ managerId: manager.id, employeeCode: code, force: true });
      toast({ title: `${name} now reports to this HOD` });
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : "Failed to reassign", variant: "destructive" });
    }
  };

  const drop = async (employeeId: number) => {
    try {
      await remove.mutateAsync({ managerId: manager.id, employeeId });
      toast({ title: "Employee removed" });
    } catch {
      toast({ title: "Failed to remove", variant: "destructive" });
    }
  };

  return (
    <Card className="border-0 shadow-sm" data-testid="individual-card">
      <div className="space-y-4 p-4 sm:p-5">
        <div>
          <h3 className="text-base font-bold text-gray-900">
            Individual employees <span className="font-semibold text-gray-400">{assigned.length}</span>
          </h3>
          <p className="mt-0.5 max-w-xl text-xs text-muted-foreground">
            For people outside the departments above, such as a report from another department. They report to this HOD
            even if their own department belongs to someone else.
          </p>
        </div>

        {assigned.length === 0 ? (
          <p className="rounded-xl bg-gray-50 px-4 py-5 text-center text-xs text-muted-foreground">
            No individual employees assigned.
          </p>
        ) : (
          <ul className="divide-y rounded-2xl border bg-white">
            {assigned.map((e) => {
              const other = elsewhere.get(e.id);
              return (
                <li
                  key={e.id}
                  className="flex items-center gap-3 px-3 py-2.5 sm:px-4"
                  data-testid={`individual-row-${e.employeeCode}`}
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-gray-500">
                    <UserRound size={16} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="truncate text-sm font-semibold text-gray-900">{e.name}</span>
                      <code className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[11px] text-gray-600">
                        {e.employeeCode}
                      </code>
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="truncate text-xs text-muted-foreground">
                        {[e.designation, e.department].filter(Boolean).join(" · ") || "No department"}
                      </span>
                      {other && (
                        <StatusBadge tone="warning">Reports to {other.currentManager.employeeName}</StatusBadge>
                      )}
                    </div>
                  </div>
                  {other && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 shrink-0 px-2 text-xs font-semibold"
                      onClick={() => void claim(e.employeeCode, e.name)}
                      disabled={assign.isPending}
                      aria-label={`Assign ${e.name} to this HOD`}
                    >
                      Assign here
                    </Button>
                  )}
                  <button
                    type="button"
                    onClick={() => void drop(e.id)}
                    aria-label={`Remove ${e.name}`}
                    title="Remove"
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-red-50 hover:text-red-600"
                    data-testid={`individual-remove-${e.employeeCode}`}
                  >
                    <X size={16} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="min-w-0 flex-1">
            <EmployeeSearchSelect
              employees={employees.filter((e) => !assigned.some((a) => a.id === e.id))}
              value={newEmpId}
              onChange={setNewEmpId}
              placeholder="Search an employee to assign…"
              dataTestId="individual-employee-select"
            />
          </div>
          <Button
            className="h-9 shrink-0 gap-1.5"
            onClick={() => void add()}
            disabled={!newEmpId || assign.isPending}
            data-testid="add-individual"
          >
            <Plus size={14} /> Add Employee
          </Button>
        </div>
      </div>

      <EmployeeConflictDialog
        conflict={conflict}
        onConfirm={() => void confirmReassign()}
        onClose={() => setConflict(null)}
        pending={assign.isPending}
      />
    </Card>
  );
}
