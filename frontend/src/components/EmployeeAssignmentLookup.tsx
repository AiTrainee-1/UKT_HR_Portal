import { useMemo, useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { Search, Building2, BriefcaseBusiness, UserRound, X, Loader2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { isRouteViewOnly, useAuth } from "@/contexts/AuthContext";
import { moduleForPath } from "@/lib/permission-modules";
import { Gate, ViewOnlyTabNote, pickVisible, useLevel, visibleItems } from "@/lib/tab-access";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PillTabs } from "@/components/ui/pill-tabs";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useDebounced } from "@/hooks/use-debounced";
import {
  useSearchEmployees, useAssignEmployee, useListEmployeesLite,
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

type LookupTab = "search" | "unassigned";
const LOOKUP_TABS: readonly LookupTab[] = ["search", "unassigned"];

export function EmployeeAssignmentLookup({
  kind,
  options,
  listSearch,
  onListSearchChange,
  subTabKeys,
}: {
  /** Which assignment this instance manages. */
  kind: "department" | "designation";
  /** The departments or designations that can be assigned. */
  options: Option[];
  /** The page's own department/designation filter, hosted here so the two
   *  searches sit side by side instead of stacking down the page. Leave both
   *  out when the page has a filter bar of its own. */
  listSearch?: string;
  onListSearchChange?: (v: string) => void;
  /** Each sub-tab's own permission key (Account Management -> Roles &
   *  Permissions), e.g. "employees.departments.find.search": a hidden one is
   *  not offered (its list is never fetched), a View-only one locks its own
   *  controls. Each key's dotted parent is the tab this lookup sits in. Leave
   *  out and both sub-tabs are always shown. */
  subTabKeys?: Record<LookupTab, string>;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const assignMutation = useAssignEmployee();
  const { user } = useAuth();
  const [location] = useLocation();

  const level = useLevel();
  const visibleTabs = visibleItems(LOOKUP_TABS, (t) => subTabKeys?.[t], level);
  const [askedTab, setTab] = useState<LookupTab>("search");
  const tab = pickVisible(askedTab, visibleTabs);
  const tabKey = subTabKeys?.[tab];
  const parentKey = tabKey ? tabKey.slice(0, tabKey.lastIndexOf(".")) : "";
  // The note only when the tab this lookup sits in is editable on an editable page (otherwise a note above already
  // says so); the Gate below locks the sub-tab's own controls either way.
  const subTabViewOnly =
    !!tabKey &&
    level(tabKey) === "view" &&
    level(parentKey) === "edit" &&
    !isRouteViewOnly(user, location, moduleForPath(location));
  const [query, setQuery] = useState("");
  /** Filters the unassigned list client-side -it is already fully loaded,
   *  so there is nothing to gain from a round trip per keystroke. */
  const [unassignedQuery, setUnassignedQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  /** Which row is mid-assign, so only that button shows a spinner. */
  const [busyId, setBusyId] = useState<number | null>(null);

  // The server is asked once typing pauses, not once per letter. Until that
  // pause the box reads as "Searching…", never as "no match".
  const debouncedQuery = useDebounced(query);
  const searchPending = query !== debouncedQuery;
  const { data: results, isFetching } = useSearchEmployees(debouncedQuery);

  // Every active employee, so the unassigned set can be derived. Only
  // fetched while that tab is open -it is the whole roster.
  const { data: allEmployees, isLoading: allLoading } = useListEmployeesLite(
    { status: "active" },
    { enabled: tab === "unassigned" },
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
  // The last matches stay listed while the next search loads, but never under
  // a box holding fewer than 2 characters.
  const shownResults = typedEnough ? results ?? [] : [];

  return (
    <Card className="border-0 shadow-sm">
      {/* A column with a gap (not space-y): a View-only sub-tab sits in a
          display:contents Gate, which space-y's margins would skip. */}
      <CardContent className="flex flex-col gap-3 p-4">
        {/* Tabs left, the page's own list filter right -it used to be a
            full-width input above this card, which wasted the whole right
            half of the row. */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          {visibleTabs.length > 0 && (
          <PillTabs
            items={visibleItems(
              [
                { value: "search", label: "Find employee", color: "#374151" },
                {
                  value: "unassigned",
                  label: "Unassigned",
                  count: tab === "unassigned" ? unassigned.length : undefined,
                  color: "#dc2626",
                },
              ],
              (t) => subTabKeys?.[t.value as LookupTab],
              level,
            )}
            value={tab}
            onChange={(v) => setTab(v as LookupTab)}
          />
          )}

          {onListSearchChange && (
            <div className="relative w-full sm:w-64">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder={kind === "department" ? "Search departments…" : "Search designations…"}
                value={listSearch ?? ""}
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
          )}
        </div>

        <ViewOnlyTabNote show={subTabViewOnly} testId="assignment-lookup-view-only" />

        {visibleTabs.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground" data-testid="assignment-lookup-nothing-open">
            Nothing on this page is open to your role.
          </p>
        ) : (
        <MaybeGate key={tab} k={tabKey}>
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
            {typedEnough && (isFetching || searchPending) && (
              <p className="text-xs text-muted-foreground">Searching…</p>
            )}
            {typedEnough && !isFetching && !searchPending && shownResults.length === 0 && (
              <p className="text-xs text-muted-foreground">No active employee matches “{query}”.</p>
            )}

            {shownResults.length > 0 && (
              <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                {shownResults.map((emp) => (
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
        </MaybeGate>
        )}
      </CardContent>
    </Card>
  );
}

/** A sub-tab's content under its own key (Gate), or as it is when the host page gave no keys. */
function MaybeGate({ k, children }: { k?: string; children: ReactNode }) {
  return k ? <Gate k={k}>{children}</Gate> : <>{children}</>;
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
