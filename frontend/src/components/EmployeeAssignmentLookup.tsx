import { useMemo, useState } from "react";
import { Search, Building2, BriefcaseBusiness, UserRound, X, Loader2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PillTabs } from "@/components/ui/pill-tabs";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  useSearchEmployees, useAssignEmployee, useListEmployees,
  getListEmployeesQueryKey, getListDepartmentsQueryKey,
} from "@/lib/api-client";
import { DataPagination } from "@/components/ui/DataPagination";

/**
 * Employee lookup + unassigned worklist, for the Departments and
 * Designations pages.
 *
 * Two tabs, mirroring Manage Shift's Assigned/Unassigned split:
 *
 *  • Search   -"where is this person assigned?", answered directly. The
 *    pages carried this before, but only inside a card's Assign dialog, so
 *    you had to guess the right department before you could find out which
 *    department someone was in.
 *  • Unassigned -everyone still missing this assignment, each with an
 *    inline picker. This is the bulk path: with 248 employees and no
 *    designations set, doing it one card at a time is not realistic.
 *
 * Both views show department AND designation, whichever page is hosting —
 * when you are setting someone's designation you almost always want their
 * department visible as context.
 */

interface Option {
  id: number;
  label: string;
}

export function EmployeeAssignmentLookup({
  kind,
  options,
  listSearch,
  onListSearchChange,
}: {
  /** Which assignment this instance manages. */
  kind: "department" | "designation";
  /** The departments or designations that can be assigned. */
  options: Option[];
  /** The page's own department/designation filter, hosted here so the two
   *  searches sit side by side instead of stacking down the page. */
  listSearch: string;
  onListSearchChange: (v: string) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const assignMutation = useAssignEmployee();

  const [tab, setTab] = useState<"search" | "unassigned">("search");
  const [query, setQuery] = useState("");
  /** Filters the unassigned list client-side -it is already fully loaded,
   *  so there is nothing to gain from a round trip per keystroke. */
  const [unassignedQuery, setUnassignedQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  /** Which row is mid-assign, so only that button shows a spinner. */
  const [busyId, setBusyId] = useState<number | null>(null);

  const { data: results, isFetching } = useSearchEmployees(query);

  // Every active employee, so the unassigned set can be derived. Only
  // fetched while that tab is open -it is the whole roster.
  const { data: allEmployees, isLoading: allLoading } = useListEmployees(
    { status: "active" } as any,
    { query: { enabled: tab === "unassigned" } } as any,
  );

  const unassigned = useMemo(() => {
    const missing = (allEmployees ?? []).filter((e) =>
      kind === "department" ? e.departmentId == null : (e as any).designationId == null,
    );
    const q = unassignedQuery.trim().toLowerCase();
    if (!q) return missing;
    return missing.filter((e) =>
      `${e.firstName ?? ""} ${e.lastName ?? ""}`.toLowerCase().includes(q) ||
      (e.employeeCode ?? "").toLowerCase().includes(q),
    );
  }, [allEmployees, kind, unassignedQuery]);

  const totalPages = Math.max(1, Math.ceil(unassigned.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pagedUnassigned = unassigned.slice((safePage - 1) * pageSize, safePage * pageSize);

  const assign = async (empId: number, optionId: number, name: string) => {
    setBusyId(empId);
    try {
      await assignMutation.mutateAsync(
        kind === "department"
          ? { id: empId, departmentId: optionId }
          : { id: empId, designationId: optionId },
      );
      // Both lists move: the employee leaves the unassigned set, and the
      // card's count goes up.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getListEmployeesQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getListDepartmentsQueryKey() }),
        queryClient.invalidateQueries({ queryKey: ["/api/designations"] }),
      ]);
      toast({ title: `${name} assigned` });
    } catch {
      toast({ title: "Failed to assign", variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const label = kind === "department" ? "department" : "designation";
  const typedEnough = query.trim().length >= 2;

  return (
    <Card className="border-0 shadow-sm">
      <CardContent className="space-y-3 p-4">
        {/* Tabs left, the page's own list filter right -it used to be a
            full-width input above this card, which wasted the whole right
            half of the row. */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <PillTabs
            items={[
              { value: "search", label: "Find employee", color: "#374151" },
              {
                value: "unassigned",
                label: "Unassigned",
                count: tab === "unassigned" ? unassigned.length : undefined,
                color: "#dc2626",
              },
            ]}
            value={tab}
            onChange={(v) => setTab(v as "search" | "unassigned")}
          />

          <div className="relative w-full sm:w-64">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder={kind === "department" ? "Search departments…" : "Search designations…"}
              value={listSearch}
              onChange={(e) => onListSearchChange(e.target.value)}
              className="h-9 pl-9 pr-8 text-sm"
            />
            {listSearch && (
              <Button
                variant="ghost"
                size="icon"
                className="absolute right-1 top-1/2 h-6 w-6 -translate-y-1/2"
                onClick={() => onListSearchChange("")}
                aria-label="Clear"
              >
                <X size={12} />
              </Button>
            )}
          </div>
        </div>

        {tab === "search" ? (
          <>
            <p className="text-xs text-muted-foreground">
              Search by name or employee code to see their current department and designation.
            </p>

            <div className="relative max-w-sm">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Employee name or code…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-9 pr-9"
              />
              {query && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2"
                  onClick={() => setQuery("")}
                  aria-label="Clear search"
                >
                  <X size={13} />
                </Button>
              )}
            </div>

            {/* The hook only fires at 2+ characters, so this mirrors that
                rather than claiming "no results" for a single letter. */}
            {query.trim().length > 0 && !typedEnough && (
              <p className="text-xs text-muted-foreground">Keep typing — at least 2 characters.</p>
            )}
            {typedEnough && isFetching && <p className="text-xs text-muted-foreground">Searching…</p>}
            {typedEnough && !isFetching && (results?.length ?? 0) === 0 && (
              <p className="text-xs text-muted-foreground">No active employee matches “{query}”.</p>
            )}

            {(results ?? []).length > 0 && (
              <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                {(results ?? []).map((emp) => (
                  <EmployeeRow key={emp.id} emp={emp} kind={kind} />
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                Active employees with no {label} yet. Pick one to assign it straight away.
              </p>
              <div className="relative w-full sm:w-64">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Filter by name or code…"
                  value={unassignedQuery}
                  onChange={(e) => {
                    setUnassignedQuery(e.target.value);
                    setPage(1);   // a shorter list must not leave you on page 9
                  }}
                  className="h-9 pl-9 pr-8 text-sm"
                />
                {unassignedQuery && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="absolute right-1 top-1/2 h-6 w-6 -translate-y-1/2"
                    onClick={() => { setUnassignedQuery(""); setPage(1); }}
                    aria-label="Clear"
                  >
                    <X size={12} />
                  </Button>
                )}
              </div>
            </div>

            {allLoading ? (
              <p className="text-xs text-muted-foreground">Loading employees…</p>
            ) : unassigned.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {unassignedQuery
                  ? `No unassigned employee matches “${unassignedQuery}”.`
                  : `Every active employee has a ${label}.`}
              </p>
            ) : options.length === 0 ? (
              <p className="py-6 text-center text-sm text-amber-700">
                No {label}s exist yet — create one first, then assign employees to it.
              </p>
            ) : (
              <>
                <div className="space-y-2">
                  {pagedUnassigned.map((emp) => (
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
                          {kind === "designation"
                            ? emp.departmentName ?? "No department"
                            : (emp as any).designationTitle ?? "No designation"}
                        </p>
                      </div>

                      <div className="flex items-center gap-2">
                        {busyId === emp.id && (
                          <Loader2 size={14} className="animate-spin text-muted-foreground" />
                        )}
                        <Select
                          disabled={busyId != null}
                          onValueChange={(v) =>
                            assign(emp.id, Number(v), `${emp.firstName} ${emp.lastName}`)
                          }
                        >
                          <SelectTrigger className="h-8 w-[190px] text-xs">
                            <SelectValue placeholder={`Assign ${label}…`} />
                          </SelectTrigger>
                          <SelectContent>
                            {options.map((o) => (
                              <SelectItem key={o.id} value={String(o.id)}>
                                {o.label}
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

/** One search result: who they are, and both current assignments. */
function EmployeeRow({
  emp,
  kind,
}: {
  emp: { id: number; firstName?: string | null; lastName?: string | null; employeeCode?: string | null; departmentName?: string | null };
  kind: "department" | "designation";
}) {
  const desig = (emp as { designationTitle?: string | null }).designationTitle;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
      <p className="flex items-center gap-2 text-sm font-semibold text-gray-900">
        <UserRound size={13} className="shrink-0 text-gray-400" />
        {emp.firstName} {emp.lastName}
        <span className="font-mono text-[11px] font-normal text-gray-400">{emp.employeeCode}</span>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={kind === "department" ? "default" : "secondary"} className="gap-1.5 font-medium">
          <Building2 size={11} />
          {emp.departmentName ?? "No department"}
        </Badge>
        <Badge variant={kind === "designation" ? "default" : "secondary"} className="gap-1.5 font-medium">
          <BriefcaseBusiness size={11} />
          {desig ?? "No designation"}
        </Badge>
      </div>
    </div>
  );
}

export default EmployeeAssignmentLookup;
