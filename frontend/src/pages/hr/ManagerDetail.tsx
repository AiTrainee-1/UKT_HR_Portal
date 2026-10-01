import { useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { ArrowLeft, GitBranch } from "lucide-react";
import HrLayout from "@/components/HrLayout";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { canView, useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { useListEmployees } from "@/lib/api-client";
import {
  useAssignEmployeeToManager,
  useGetDepartmentManager,
  useUpdateDepartmentManager,
  type RosterEmployee,
} from "@/lib/api-client/custom-hooks";
import { ApprovalPermissionPicker } from "./user-management/ApprovalPermissionPicker";
import { allPermissions, permissionValuesOf, type PermKey } from "./user-management/approval-permissions";
import DepartmentsCard from "./user-management/manager-detail/DepartmentsCard";
import IndividualCard from "./user-management/manager-detail/IndividualCard";
import ManagerHero from "./user-management/manager-detail/ManagerHero";

// One department manager (HOD): who they are, what they may approve, the departments they cover with every employee
// in them listed automatically (and removable), and the employees assigned to them one by one.
//
// A page rather than a dialog: a manager can hold several departments and dozens of employees, which is more than a
// modal should carry, and a page can be linked to and survives a refresh.

export default function ManagerDetail() {
  const [, navigate] = useLocation();
  const params = useParams<{ id: string }>();
  const managerId = Number(params.id) || null;
  const { toast } = useToast();
  const { user } = useAuth();
  const [pendingKey, setPendingKey] = useState<PermKey | "all" | null>(null);
  const [claimingId, setClaimingId] = useState<number | null>(null);

  const { data: manager, isLoading } = useGetDepartmentManager(managerId);
  const { data: employees } = useListEmployees({ status: "active" });
  const update = useUpdateDepartmentManager();
  const assignEmployee = useAssignEmployeeToManager();

  const canSeeWorkflow = canView(user, "user_management.approval_workflow");

  const save = async (key: PermKey | "all" | "active", data: Parameters<typeof update.mutateAsync>[0]["data"]) => {
    if (!managerId) return;
    if (key !== "active") setPendingKey(key);
    try {
      await update.mutateAsync({ id: managerId, data });
    } catch (e) {
      toast({
        title: "Could not save the change",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setPendingKey(null);
    }
  };

  const togglePermission = (key: PermKey) => {
    if (!manager) return;
    void save(key, { [key]: !permissionValuesOf(manager)[key] });
  };

  const setAllPermissions = (on: boolean) => void save("all", allPermissions(on));

  // Someone in the department who really reports to another HOD: move them here (an individual assignment wins).
  const claim = async (e: RosterEmployee) => {
    if (!managerId) return;
    setClaimingId(e.employeeId);
    try {
      await assignEmployee.mutateAsync({ managerId, employeeCode: e.employeeCode, force: true });
      toast({ title: `${e.name} now reports to this HOD` });
    } catch (err) {
      toast({ title: err instanceof Error ? err.message : "Failed to reassign", variant: "destructive" });
    } finally {
      setClaimingId(null);
    }
  };

  return (
    <HrLayout>
      <div className="mx-auto max-w-5xl space-y-5 pb-10" data-testid="manager-detail">
        {/* Back first, so the way out is the first thing you see. */}
        <button
          onClick={() => navigate("/hr/user-management")}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft size={15} /> Back to User Management
        </button>

        {isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-44 w-full rounded-2xl" />
            <Skeleton className="h-64 w-full rounded-2xl" />
          </div>
        ) : manager ? (
          <>
            <ManagerHero
              manager={manager}
              saving={update.isPending}
              onToggleActive={() => void save("active", { isActive: !manager.isActive })}
            />

            <Card className="border-0 shadow-sm" data-testid="permissions-card">
              <div className="space-y-4 p-4 sm:p-5">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h3 className="text-base font-bold text-gray-900">Approval permissions</h3>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      What this person may decide. Each switch saves as soon as you press it.
                    </p>
                  </div>
                  {canSeeWorkflow && (
                    <Link
                      href="/hr/user-management?tab=approvals"
                      className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline"
                    >
                      <GitBranch size={12} /> See how requests are routed
                    </Link>
                  )}
                </div>
                <ApprovalPermissionPicker
                  values={permissionValuesOf(manager)}
                  onToggle={togglePermission}
                  onSetAll={setAllPermissions}
                  pendingKey={pendingKey}
                  columns="grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"
                />
              </div>
            </Card>

            <DepartmentsCard
              managerId={manager.id}
              managerName={manager.employeeName}
              onClaim={(e) => void claim(e)}
              claimingId={claimingId}
            />

            <IndividualCard manager={manager} employees={employees ?? []} />
          </>
        ) : (
          <p className="py-16 text-center text-sm text-muted-foreground">This user no longer exists.</p>
        )}
      </div>
    </HrLayout>
  );
}
