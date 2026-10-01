import { useMemo, useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { Building2, Clock, Plus, Shield, TriangleAlert, UserCheck, Users } from "lucide-react";
import { ManagerAssignmentLookup } from "@/components/ManagerAssignmentLookup";
import { Button } from "@/components/ui/button";
import { CircleLoader } from "@/components/ui/CircleLoader";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  useDeleteDepartmentManager,
  useListDepartmentManagers,
  useUpdateDepartmentManager,
  type DepartmentManagerItem,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import CreateUserDialog from "./CreateUserDialog";
import HodCard from "./HodCard";

// HOD Assignment: who the Department Heads are, which departments / employees each one covers, and which kinds of
// request each one may decide. WHO decides what, and in what order, is Approval Workflow Control (the other tab).

type StatusFilter = "all" | "active" | "inactive";

function StatTile({ icon, tint, value, label }: { icon: ReactNode; tint: string; value: number; label: string }) {
  return (
    <div
      className="flex items-center gap-3 rounded-2xl bg-white p-4 shadow-sm"
      data-testid={`stat-${label.toLowerCase().replace(/\s+/g, "-")}`}
    >
      <span className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl", tint)}>{icon}</span>
      <div className="min-w-0">
        <p className="text-2xl font-black leading-none text-gray-900">{value}</p>
        <p className="mt-1 text-xs font-medium leading-tight text-gray-500">{label}</p>
      </div>
    </div>
  );
}

function DeleteConfirmDialog({
  manager,
  onClose,
  onConfirm,
  isPending,
}: {
  manager: DepartmentManagerItem | null;
  onClose: () => void;
  onConfirm: () => void;
  isPending: boolean;
}) {
  return (
    <Dialog open={!!manager} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader className="items-center text-center">
          <span className="mb-1 flex h-12 w-12 items-center justify-center rounded-full bg-red-50 text-red-600">
            <TriangleAlert size={22} />
          </span>
          <DialogTitle>Remove department user?</DialogTitle>
          <DialogDescription className="text-sm">
            <strong className="text-gray-900">{manager?.employeeName}</strong> ({manager?.employeeCode}) will no longer
            be able to approve requests from the mobile app. Their {manager?.departmentCount ?? 0} department
            {manager?.departmentCount === 1 ? "" : "s"} and {manager?.employeeCount ?? 0} employees go back to HR until
            you assign another head.
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-3 pt-2">
          <Button variant="outline" className="flex-1" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" className="flex-1" onClick={onConfirm} disabled={isPending}>
            {isPending ? "Removing…" : "Remove User"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const STEPS = [
  {
    icon: <Plus size={16} />,
    tint: "bg-blue-50 text-blue-600",
    title: "Create the user",
    desc: "Pick an employee and choose what they may approve.",
  },
  {
    icon: <Building2 size={16} />,
    tint: "bg-indigo-50 text-indigo-600",
    title: "Assign departments",
    desc: "Everyone in a department is listed automatically; remove anyone who should report elsewhere.",
  },
  {
    icon: <Clock size={16} />,
    tint: "bg-emerald-50 text-emerald-600",
    title: "Approve on mobile",
    desc: "The head sees an Approvals tab in the mobile app for their team's requests.",
  },
];

export default function HodAssignmentTab() {
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [deleteManager, setDeleteManager] = useState<DepartmentManagerItem | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const { data: managers = [], isLoading } = useListDepartmentManagers();
  const deleteMutation = useDeleteDepartmentManager();
  const updateMutation = useUpdateDepartmentManager();

  const handleDelete = async () => {
    if (!deleteManager) return;
    try {
      await deleteMutation.mutateAsync(deleteManager.id);
      toast({ title: `${deleteManager.employeeName} removed as department user` });
      setDeleteManager(null);
    } catch {
      toast({ title: "Failed to remove user", variant: "destructive" });
    }
  };

  const toggleActive = async (m: DepartmentManagerItem) => {
    try {
      await updateMutation.mutateAsync({ id: m.id, data: { isActive: !m.isActive } });
    } catch {
      toast({ title: "Could not change the user", variant: "destructive" });
    }
  };

  const activeCount = managers.filter((m) => m.isActive).length;
  const takenEmployeeIds = useMemo(() => managers.map((m) => m.employeeId), [managers]);

  // The search box lives in the lookup card above (it answers "who is this HOD?" too); the status chips are here.
  const visibleManagers = managers.filter((m) => {
    if (statusFilter === "active" && !m.isActive) return false;
    if (statusFilter === "inactive" && m.isActive) return false;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (
      m.employeeName.toLowerCase().includes(q) ||
      m.employeeCode.toLowerCase().includes(q) ||
      (m.department ?? "").toLowerCase().includes(q)
    );
  });

  const chips: { value: StatusFilter; label: string; count: number }[] = [
    { value: "all", label: "All", count: managers.length },
    { value: "active", label: "Active", count: activeCount },
    { value: "inactive", label: "Inactive", count: managers.length - activeCount },
  ];

  return (
    <>
      <div className="space-y-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-3xl text-sm text-muted-foreground">
            Assign employees as department approvers. They receive and act on the requests of their team in the mobile
            app. Who approves what, and in which order, is set in Approval Workflow Control.
          </p>
          <Button className="shrink-0 gap-2" onClick={() => setShowCreateDialog(true)} data-testid="create-user">
            <Plus size={15} /> Create User
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            icon={<Users size={18} />}
            tint="bg-blue-50 text-blue-600"
            value={managers.length}
            label="Department users"
          />
          <StatTile
            icon={<UserCheck size={18} />}
            tint="bg-emerald-50 text-emerald-600"
            value={activeCount}
            label="Active"
          />
          <StatTile
            icon={<Building2 size={18} />}
            tint="bg-indigo-50 text-indigo-600"
            value={managers.reduce((s, m) => s + m.departmentCount, 0)}
            label="Departments covered"
          />
          <StatTile
            icon={<Shield size={18} />}
            tint="bg-violet-50 text-violet-600"
            value={managers.filter((m) => m.isActive).reduce((s, m) => s + m.employeeCount, 0)}
            label="Employees covered"
          />
        </div>

        <ManagerAssignmentLookup
          managers={managers}
          managersLoading={isLoading}
          listSearch={search}
          onListSearchChange={setSearch}
        />

        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-1.5 text-sm font-bold text-gray-900">
              <Shield size={14} className="text-blue-600" /> Roles &amp; permissions
            </h3>
            <div
              className="inline-flex rounded-full bg-gray-100 p-0.5"
              role="group"
              aria-label="Filter department users"
            >
              {chips.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  aria-pressed={statusFilter === c.value}
                  onClick={() => setStatusFilter(c.value)}
                  data-testid={`hod-filter-${c.value}`}
                  className={cn(
                    "rounded-full px-3 py-1 text-xs font-semibold transition-colors",
                    statusFilter === c.value ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-800",
                  )}
                >
                  {c.label} <span className="ml-0.5 text-gray-400">{c.count}</span>
                </button>
              ))}
            </div>
          </div>

          {isLoading ? (
            <CircleLoader texts={["UK Textiles", "User Management", "Loading"]} />
          ) : visibleManagers.length === 0 ? (
            <div className="rounded-2xl border-2 border-dashed border-gray-200 bg-white/60 py-14 text-center">
              <UserCheck size={34} className="mx-auto mb-3 text-gray-300" />
              <p className="font-semibold text-gray-600">
                {managers.length === 0 ? "No department users yet" : "No department user matches"}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {managers.length === 0 ? (
                  <>
                    Click <strong>Create User</strong> to assign an employee as a department approver.
                  </>
                ) : (
                  "Try a different search or filter."
                )}
              </p>
              {managers.length === 0 && (
                <Button className="mt-4 gap-2" variant="outline" onClick={() => setShowCreateDialog(true)}>
                  <Plus size={14} /> Create User
                </Button>
              )}
            </div>
          ) : (
            <div className="space-y-2.5">
              {visibleManagers.map((m) => (
                <HodCard
                  key={m.id}
                  manager={m}
                  onOpen={() => navigate(`/hr/user-management/${m.id}`)}
                  onToggleActive={() => toggleActive(m)}
                  onDelete={() => setDeleteManager(m)}
                  busy={updateMutation.isPending}
                />
              ))}
            </div>
          )}
        </section>

        <div className="grid grid-cols-1 gap-3 rounded-2xl bg-white p-4 shadow-sm md:grid-cols-3">
          {STEPS.map((s, i) => (
            <div key={s.title} className="flex gap-3">
              <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-xl", s.tint)}>
                {s.icon}
              </span>
              <div className="min-w-0">
                <p className="text-sm font-bold text-gray-900">
                  {i + 1}. {s.title}
                </p>
                <p className="mt-0.5 text-xs leading-4 text-gray-500">{s.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <CreateUserDialog
        open={showCreateDialog}
        onClose={() => setShowCreateDialog(false)}
        takenEmployeeIds={takenEmployeeIds}
      />
      <DeleteConfirmDialog
        manager={deleteManager}
        onClose={() => setDeleteManager(null)}
        onConfirm={handleDelete}
        isPending={deleteMutation.isPending}
      />
    </>
  );
}
