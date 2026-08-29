import { useMemo, useState } from "react";
import { Search, Shield, UserRound, X, Loader2, Building2, Factory } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PillTabs } from "@/components/ui/pill-tabs";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useListEmployees, useSearchEmployees } from "@/lib/api-client";
import { useAssignEmployeeToManager } from "@/lib/api-client/custom-hooks";
import { DataPagination } from "@/components/ui/DataPagination";

/**
 * User lookup + unassigned worklist for User Management.
 *
 *  • Find user   -search the HODs themselves by name or employee code.
 *  • Unassigned  -STAFF employees who report to no HOD, each with an inline
 *    picker to put them under one.
 *
 * Staff only, deliberately. Department heads cover staff; production
 * employees are managed through the production shift structure and are never
 * assigned an HOD. Listing all 248 active employees here would bury the 24
 * that actually need attention under 114 that never will.
 */

interface ManagerOption {
  id: number;
  employeeName: string;
  employeeCode: string;
  department?: string | null;
  employeeCount?: number;
  assignedEmployeeIds?: number[];
  isActive?: boolean;
}

export function ManagerAssignmentLookup({
  managers,
  managersLoading,
  listSearch,
  onListSearchChange,
}: {
  managers: ManagerOption[];
  managersLoading?: boolean;
  /** The page's own HOD-list filter, hosted here to fill the empty right side. */
  listSearch: string;
  onListSearchChange: (v: string) => void;
}) {
  const { toast } = useToast();
  const assignMutation = useAssignEmployeeToManager();

  const [tab, setTab] = useState<"users" | "unassigned">("users");
  const [userQuery, setUserQuery] = useState("");
  const [empQuery, setEmpQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [busyId, setBusyId] = useState<number | null>(null);

  // Only fetched while the Unassigned tab is open -it is the whole roster.
  const { data: allEmployees, isLoading: empLoading } = useListEmployees(
    { status: "active" } as any,
    { query: { enabled: tab === "unassigned" } } as any,
  );

  /** Every employee already under some HOD, across all managers. */
  const assignedIds = useMemo(
    () => new Set(managers.flatMap((m) => m.assignedEmployeeIds ?? [])),
    [managers],
  );

  const unassigned = useMemo(() => {
    const staffWithoutHod = (allEmployees ?? []).filter(
      (e) =>
        (e as any).employmentType !== "production" && !assignedIds.has(e.id),
    );
    const q = empQuery.trim().toLowerCase();
    if (!q) return staffWithoutHod;
    return staffWithoutHod.filter(
      (e) =>
        `${e.firstName ?? ""} ${e.lastName ?? ""}`.toLowerCase().includes(q) ||
        (e.employeeCode ?? "").toLowerCase().includes(q),
    );
  }, [allEmployees, assignedIds, empQuery]);

  // The same search box now answers both "who is this HOD?" and "who does
  // this person report to?" -searching a staff member and getting nothing
  // back was the gap, since their HOD is exactly what you want to see.
  const { data: staffMatches, isFetching: staffFetching } = useSearchEmployees(
    tab === "users" ? userQuery : "",
  );

  /** employeeId -> the HOD they report to. Built from every manager's
   *  assignment list, so one pass answers it for any employee. */
  const hodByEmployee = useMemo(() => {
    const map = new Map<number, ManagerOption>();
    for (const m of managers) {
      for (const id of m.assignedEmployeeIds ?? []) map.set(id, m);
    }
    return map;
  }, [managers]);

  /** HODs are also employees, and would otherwise appear in both lists. */
  const managerEmployeeIds = useMemo(
    () => new Set(managers.map((m) => (m as any).employeeId).filter(Boolean)),
    [managers],
  );

  const matchedStaff = useMemo(
    () => (staffMatches ?? []).filter((e) => !managerEmployeeIds.has(e.id)),
    [staffMatches, managerEmployeeIds],
  );

  const matchedUsers = useMemo(() => {
    const q = userQuery.trim().toLowerCase();
    if (!q) return [];
    return managers.filter(
      (m) =>
        m.employeeName.toLowerCase().includes(q) ||
        m.employeeCode.toLowerCase().includes(q) ||
        (m.department ?? "").toLowerCase().includes(q),
    );
  }, [managers, userQuery]);

  const totalPages = Math.max(1, Math.ceil(unassigned.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const paged = unassigned.slice((safePage - 1) * pageSize, safePage * pageSize);

  // Only active HODs can take new reports.
  const assignable = managers.filter((m) => m.isActive !== false);

  const assign = async (empId: number, code: string, managerId: number, name: string) => {
    setBusyId(empId);
    try {
      // The endpoint keys on employeeCode, not id.
      await assignMutation.mutateAsync({ managerId, employeeCode: code });
      toast({ title: `${name} assigned` });
    } catch (e: any) {
      toast({ title: e?.message ?? "Failed to assign", variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card className="border-0 shadow-sm">
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <PillTabs
            items={[
              { value: "users", label: "Find user", color: "#374151" },
              {
                value: "unassigned",
                label: "Unassigned staff",
                count: tab === "unassigned" ? unassigned.length : undefined,
                color: "#dc2626",
              },
            ]}
            value={tab}
            onChange={(v) => setTab(v as "users" | "unassigned")}
          />

          <div className="relative w-full sm:w-64">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search users…"
              value={listSearch}
              onChange={(e) => onListSearchChange(e.target.value)}
              className="h-9 pl-9 pr-8 text-sm"
            />
            {listSearch && (
              <Button
                variant="ghost" size="icon"
                className="absolute right-1 top-1/2 h-6 w-6 -translate-y-1/2"
                onClick={() => onListSearchChange("")}
                aria-label="Clear"
              >
                <X size={12} />
              </Button>
            )}
          </div>
        </div>

        {tab === "users" ? (
          <>
            <p className="text-xs text-muted-foreground">
              Search a department head, or any employee to see which HOD they report to.
            </p>

            <div className="relative max-w-sm">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="HOD or employee name / code…"
                value={userQuery}
                onChange={(e) => setUserQuery(e.target.value)}
                className="pl-9 pr-9"
              />
              {userQuery && (
                <Button
                  variant="ghost" size="icon"
                  className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2"
                  onClick={() => setUserQuery("")}
                  aria-label="Clear search"
                >
                  <X size={13} />
                </Button>
              )}
            </div>

            {(managersLoading || staffFetching) && (
              <p className="text-xs text-muted-foreground">Searching…</p>
            )}
            {!managersLoading && !staffFetching && userQuery.trim() &&
              matchedUsers.length === 0 && matchedStaff.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  Nothing matches “{userQuery}” — no department head and no employee.
                </p>
              )}

            {matchedUsers.length > 0 && (
              <div className="space-y-2">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Department heads
                </p>
                <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                {matchedUsers.map((m) => (
                  <div
                    key={m.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
                  >
                    <p className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                      <Shield size={13} className="shrink-0 text-blue-600" />
                      {m.employeeName}
                      <span className="font-mono text-[11px] font-normal text-gray-400">
                        {m.employeeCode}
                      </span>
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary" className="gap-1.5 font-medium">
                        <Building2 size={11} />
                        {m.department ?? "No department"}
                      </Badge>
                      <Badge variant="secondary" className="gap-1.5 font-medium">
                        <UserRound size={11} />
                        {m.employeeCount ?? 0} reporting
                      </Badge>
                    </div>
                  </div>
                ))}
                </div>
              </div>
            )}

            {matchedStaff.length > 0 && (
              <div className="space-y-2">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Employees · reporting to
                </p>
                <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                  {matchedStaff.map((emp) => {
                    const hod = hodByEmployee.get(emp.id);
                    const isProduction = (emp as any).employmentType === "production";
                    return (
                      <div
                        key={emp.id}
                        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
                      >
                        <div className="min-w-0">
                          <p className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                            <UserRound size={13} className="shrink-0 text-gray-400" />
                            {emp.firstName} {emp.lastName}
                            <span className="font-mono text-[11px] font-normal text-gray-400">
                              {emp.employeeCode}
                            </span>
                          </p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {emp.departmentName ?? "No department"}
                          </p>
                        </div>

                        {/* Production is shown as its own state, not as
                            "Unassigned" -these never get an HOD, so flagging
                            them as missing one would be a false to-do. */}
                        {isProduction ? (
                          <Badge variant="secondary" className="gap-1.5 font-medium">
                            <Factory size={11} />
                            Production — no HOD
                          </Badge>
                        ) : hod ? (
                          <Badge className="gap-1.5 font-medium">
                            <Shield size={11} />
                            {hod.employeeName}
                          </Badge>
                        ) : (
                          <Badge variant="destructive" className="gap-1.5 font-medium">
                            <Shield size={11} />
                            Unassigned
                          </Badge>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                Active <b>staff</b> with no department head yet. Production employees are
                excluded — they aren’t assigned an HOD.
              </p>
              <div className="relative w-full sm:w-64">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Filter by name or code…"
                  value={empQuery}
                  onChange={(e) => { setEmpQuery(e.target.value); setPage(1); }}
                  className="h-9 pl-9 pr-8 text-sm"
                />
                {empQuery && (
                  <Button
                    variant="ghost" size="icon"
                    className="absolute right-1 top-1/2 h-6 w-6 -translate-y-1/2"
                    onClick={() => { setEmpQuery(""); setPage(1); }}
                    aria-label="Clear"
                  >
                    <X size={12} />
                  </Button>
                )}
              </div>
            </div>

            {empLoading ? (
              <p className="text-xs text-muted-foreground">Loading employees…</p>
            ) : assignable.length === 0 ? (
              <p className="py-6 text-center text-sm text-amber-700">
                No active department head exists yet — create one first.
              </p>
            ) : unassigned.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {empQuery
                  ? `No unassigned staff matches “${empQuery}”.`
                  : "Every active staff member reports to a department head."}
              </p>
            ) : (
              <>
                <div className="space-y-2">
                  {paged.map((emp) => (
                    <div
                      key={emp.id}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
                    >
                      <div className="min-w-0">
                        <p className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                          <UserRound size={13} className="shrink-0 text-gray-400" />
                          {emp.firstName} {emp.lastName}
                          <span className="font-mono text-[11px] font-normal text-gray-400">
                            {emp.employeeCode}
                          </span>
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {emp.departmentName ?? "No department"}
                        </p>
                      </div>

                      <div className="flex items-center gap-2">
                        {busyId === emp.id && (
                          <Loader2 size={14} className="animate-spin text-muted-foreground" />
                        )}
                        <Select
                          disabled={busyId != null}
                          onValueChange={(v) =>
                            assign(
                              emp.id,
                              emp.employeeCode ?? "",
                              Number(v),
                              `${emp.firstName} ${emp.lastName}`,
                            )
                          }
                        >
                          <SelectTrigger className="h-8 w-[210px] text-xs">
                            <SelectValue placeholder="Assign to HOD…" />
                          </SelectTrigger>
                          <SelectContent>
                            {assignable.map((m) => (
                              <SelectItem key={m.id} value={String(m.id)}>
                                {m.employeeName}
                                {m.department ? ` · ${m.department}` : ""}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  ))}
                </div>

                <DataPagination
                  page={safePage}
                  totalPages={totalPages}
                  totalItems={unassigned.length}
                  pageSize={pageSize}
                  onPageChange={setPage}
                  onPageSizeChange={setPageSize}
                />
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default ManagerAssignmentLookup;
