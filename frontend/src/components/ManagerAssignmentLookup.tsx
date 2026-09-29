import { useMemo, useState } from "react";
import { Search, Shield, UserRound, X, Loader2, Building2, Factory } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
 *  • Find user   -search the HODs themselves, or any employee to see which HOD they
 *    report to. Its search box is the page's HOD-list filter too.
 *  • Unassigned  -STAFF employees who report to no HOD, each with an inline
 *    picker to put them under one. Its search box filters ONLY this list: it never
 *    touches the HOD cards below (the old shared box did, which made typing a name
 *    here silently empty that list).
 *
 * Staff only, deliberately. Department heads cover staff; production
 * employees are managed through the production shift structure and are never
 * assigned an HOD. Listing all 248 active employees here would bury the 24
 * that actually need attention under 114 that never will.
 */

function SearchField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div className="flex h-10 w-full items-center gap-2 rounded-lg border bg-background px-3 shadow-sm transition-colors focus-within:border-primary/60 focus-within:ring-2 focus-within:ring-primary/15 sm:w-80">
      <Search size={15} className="shrink-0 text-muted-foreground" aria-hidden />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        autoComplete="off"
        spellCheck={false}
        className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear search"
          className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}

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

  /** Every active staff member with no HOD, before the search box is applied. */
  const staffWithoutHod = useMemo(
    () =>
      (allEmployees ?? []).filter(
        (e) => (e as any).employmentType !== "production" && !assignedIds.has(e.id),
      ),
    [allEmployees, assignedIds],
  );

  const unassigned = useMemo(() => {
    const q = empQuery.trim().toLowerCase();
    if (!q) return staffWithoutHod;
    return staffWithoutHod.filter(
      (e) =>
        `${e.firstName ?? ""} ${e.lastName ?? ""}`.toLowerCase().includes(q) ||
        (e.employeeCode ?? "").toLowerCase().includes(q) ||
        (e.departmentName ?? "").toLowerCase().includes(q),
    );
  }, [staffWithoutHod, empQuery]);

  // The same search box now answers both "who is this HOD?" and "who does
  // this person report to?" -searching a staff member and getting nothing
  // back was the gap, since their HOD is exactly what you want to see.
  // Driven by `listSearch` (the single search box in the header above) -
  // there used to be a second, near-identical box just for this, which read
  // as two different searches doing two different things side by side.
  const { data: staffMatches, isFetching: staffFetching } = useSearchEmployees(
    tab === "users" ? listSearch : "",
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
    const q = listSearch.trim().toLowerCase();
    if (!q) return [];
    return managers.filter(
      (m) =>
        m.employeeName.toLowerCase().includes(q) ||
        m.employeeCode.toLowerCase().includes(q) ||
        (m.department ?? "").toLowerCase().includes(q),
    );
  }, [managers, listSearch]);

  const totalPages = Math.max(1, Math.ceil(unassigned.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const paged = unassigned.slice((safePage - 1) * pageSize, safePage * pageSize);

  // The Unassigned tab has its own search, so the page's HOD-list filter must not stay applied
  // (unseen) when leaving the Find user tab -it would keep narrowing the HOD cards below.
  const changeTab = (v: "users" | "unassigned") => {
    setTab(v);
    setPage(1);
    if (v === "unassigned") onListSearchChange("");
  };

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
                // The total, not the filtered count: the tab name says how many staff are waiting.
                count: tab === "unassigned" ? staffWithoutHod.length : undefined,
                color: "#dc2626",
              },
            ]}
            value={tab}
            onChange={(v) => changeTab(v as "users" | "unassigned")}
          />

          {/* ONE search box; what it searches follows the tab, so it always filters what you are looking at. */}
          {tab === "users" ? (
            <SearchField
              value={listSearch}
              onChange={onListSearchChange}
              placeholder="Search a department head or employee…"
            />
          ) : (
            <SearchField
              value={empQuery}
              onChange={(v) => { setEmpQuery(v); setPage(1); }}
              placeholder="Search unassigned staff by name, code or department…"
            />
          )}
        </div>

        {tab === "users" ? (
          <>
            <p className="text-xs text-muted-foreground">
              Type a name or code to find a department head, or any employee and the HOD they report to.
            </p>

            {(managersLoading || staffFetching) && (
              <p className="text-xs text-muted-foreground">Searching…</p>
            )}
            {!managersLoading && !staffFetching && listSearch.trim() &&
              matchedUsers.length === 0 && matchedStaff.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  Nothing matches “{listSearch}” — no department head and no employee.
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
            <p className="text-xs text-muted-foreground">
              {empQuery.trim() ? (
                <>
                  <b>{unassigned.length}</b> of {staffWithoutHod.length} unassigned staff match “{empQuery.trim()}”.
                </>
              ) : (
                <>
                  <b>{staffWithoutHod.length}</b> active staff have no department head yet. Production employees are
                  excluded.
                </>
              )}
            </p>

            {empLoading ? (
              <p className="text-xs text-muted-foreground">Loading employees…</p>
            ) : assignable.length === 0 ? (
              <p className="py-6 text-center text-sm text-amber-700">
                No active department head exists yet — create one first.
              </p>
            ) : unassigned.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {empQuery.trim()
                  ? `No unassigned staff matches “${empQuery.trim()}”.`
                  : "Every active staff member reports to a department head."}
              </p>
            ) : (
              <>
                <div className="overflow-hidden rounded-lg border">
                  {/* Same three columns in the header and in every row, so names, departments and
                      the HOD pickers line up down the whole list. */}
                  <div className="hidden grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_230px] gap-4 border-b bg-muted/40 px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground sm:grid">
                    <span>Employee</span>
                    <span>Department</span>
                    <span>Assign to HOD</span>
                  </div>
                  <div className="divide-y">
                    {paged.map((emp) => (
                      <div
                        key={emp.id}
                        className="grid grid-cols-1 items-center gap-2 px-4 py-2.5 transition-colors hover:bg-muted/30 sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_230px] sm:gap-4"
                      >
                        <div className="flex min-w-0 items-center gap-2.5">
                          <UserRound size={14} className="shrink-0 text-gray-400" />
                          <p className="min-w-0 truncate text-sm font-semibold text-gray-900">
                            {emp.firstName} {emp.lastName}
                          </p>
                          <span className="shrink-0 font-mono text-[11px] text-gray-400">{emp.employeeCode}</span>
                        </div>

                        <p className="truncate text-sm text-muted-foreground">
                          {emp.departmentName ?? "No department"}
                        </p>

                        <div className="flex items-center gap-2">
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
                            <SelectTrigger className="h-8 w-full text-xs">
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
                          {busyId === emp.id && (
                            <Loader2 size={14} className="shrink-0 animate-spin text-muted-foreground" />
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
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
