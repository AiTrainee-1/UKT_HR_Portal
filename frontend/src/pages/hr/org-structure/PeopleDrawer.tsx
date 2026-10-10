import { useMemo, useState, type ReactNode } from "react";
import { Search, UserMinus, UserPlus, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import type { Person } from "./api";
import { NO_PEOPLE_FILTERS, filterPeople, plural, summarizePeople, type PeopleFilters } from "./logic";
import { PersonAvatar, SplitBar, TypeChip } from "./parts";

type Props = {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Branch / department chips under the title. */
  subtitle?: ReactNode;
  /** Which assignment a row's remove button clears: names the button and the empty state. */
  kind: "department" | "designation";
  people: Person[] | undefined;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  /** The column that tells where else the person sits: their designation in a department, their department in a designation. */
  showOther: "designation" | "department";
  onAssign: () => void;
  onRemove: (p: Person) => void;
  removingId: number | null;
};

/** Who is in a department or holds a designation: staff and production told apart, searchable, inactive on request. */
export default function PeopleDrawer({
  open,
  onClose,
  title,
  subtitle,
  kind,
  people,
  loading,
  failed,
  onRetry,
  showOther,
  onAssign,
  onRemove,
  removingId,
}: Props) {
  const [filters, setFilters] = useState<PeopleFilters>(NO_PEOPLE_FILTERS);
  const all = useMemo(() => people ?? [], [people]);
  const summary = useMemo(() => summarizePeople(all), [all]);
  const shown = useMemo(() => filterPeople(all, filters), [all, filters]);
  const set = (patch: Partial<PeopleFilters>) => setFilters((f) => ({ ...f, ...patch }));
  const narrowed = filters.query.trim() !== "" || filters.type !== "all" || filters.status !== "active";

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-lg" data-testid="people-drawer">
        <SheetHeader className="space-y-2 border-b p-5 pr-12 text-left">
          <SheetTitle className="text-xl font-black text-gray-900">{title}</SheetTitle>
          <SheetDescription asChild>
            <div className="flex flex-wrap items-center gap-1.5 text-sm">{subtitle}</div>
          </SheetDescription>
          <div className="pt-1">
            <SplitBar staff={summary.staff} production={summary.production} />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <p className="text-xs text-gray-500" data-testid="drawer-counts">
              <b className="text-gray-900">{summary.active}</b> active
              {summary.inactive > 0 && <> · {summary.inactive} inactive</>}
            </p>
            <Button size="sm" className="h-8 gap-1.5" onClick={onAssign} data-testid="drawer-assign">
              <UserPlus size={13} /> Assign employee
            </Button>
          </div>
        </SheetHeader>

        <div className="space-y-2 border-b p-4">
          <div className="relative">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <Input
              value={filters.query}
              onChange={(e) => set({ query: e.target.value })}
              placeholder="Search name, code or designation"
              aria-label="Search employees"
              className="h-9 pl-9 pr-8"
              data-testid="drawer-search"
            />
            {filters.query && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => set({ query: "" })}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 hover:text-gray-700"
              >
                <X size={13} />
              </button>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <PillTabs
              size="sm"
              items={[
                { value: "all", label: "All" },
                { value: "staff", label: "Staff", count: summary.staff, color: "#2563eb" },
                { value: "production", label: "Production", count: summary.production, color: "#d97706" },
              ]}
              value={filters.type}
              onChange={(v) => set({ type: v as PeopleFilters["type"] })}
            />
            <PillTabs
              size="sm"
              items={[
                { value: "active", label: "Active" },
                { value: "inactive", label: "Inactive", count: summary.inactive },
                { value: "all", label: "Both" },
              ]}
              value={filters.status}
              onChange={(v) => set({ status: v as PeopleFilters["status"] })}
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4" data-testid="drawer-list">
          {loading ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3">
                  <Skeleton className="h-9 w-9 rounded-full" />
                  <div className="space-y-1.5">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="h-3 w-24" />
                  </div>
                </div>
              ))}
            </div>
          ) : failed ? (
            <div className="space-y-3 py-8 text-center" data-testid="drawer-error">
              <p className="text-sm text-red-700">Could not load the employees.</p>
              <Button variant="outline" size="sm" onClick={onRetry}>
                Retry
              </Button>
            </div>
          ) : shown.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center" data-testid="drawer-empty">
              <div className="rounded-2xl bg-gray-100 p-3 text-gray-500">
                <Users size={22} />
              </div>
              <p className="font-semibold text-gray-900">
                {narrowed && all.length > 0
                  ? "Nobody matches"
                  : `Nobody ${kind === "department" ? "is in this department" : "holds this designation"}`}
              </p>
              {narrowed && all.length > 0 ? (
                <Button variant="outline" size="sm" onClick={() => setFilters(NO_PEOPLE_FILTERS)}>
                  Clear filters
                </Button>
              ) : (
                <Button size="sm" className="gap-1.5" onClick={onAssign}>
                  <UserPlus size={13} /> Assign an employee
                </Button>
              )}
            </div>
          ) : (
            <ul className="divide-y" data-testid="drawer-people">
              {shown.map((p) => {
                const inactive = p.status !== "active";
                const other = showOther === "designation" ? p.designationTitle : p.departmentName;
                return (
                  <li
                    key={p.id}
                    className={cn("flex items-center gap-3 py-2.5", inactive && "opacity-70")}
                    data-testid={`person-${p.employeeCode}`}
                    data-status={p.status}
                    data-type={p.employmentType}
                  >
                    <PersonAvatar name={p.name} seed={p.id} muted={inactive} />
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-gray-900">
                        <span className="truncate">{p.name}</span>
                        <TypeChip type={p.employmentType} />
                        {inactive && (
                          <span className="rounded-full border border-gray-200 bg-gray-100 px-2 py-0.5 text-[11px] font-semibold capitalize text-gray-500">
                            {p.status}
                          </span>
                        )}
                      </p>
                      <p className="truncate text-xs text-gray-500">
                        <span className="font-mono">{p.employeeCode}</span>
                        {" · "}
                        {other ?? (showOther === "designation" ? "No designation" : "No department")}
                      </p>
                    </div>
                    {!inactive && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 shrink-0 text-gray-300 hover:bg-red-50 hover:text-red-500"
                        title={kind === "department" ? "Remove from department" : "Remove designation"}
                        aria-label={`${kind === "department" ? "Remove from department" : "Remove designation from"} ${p.name}`}
                        onClick={() => onRemove(p)}
                        disabled={removingId === p.id}
                        data-testid={`person-remove-${p.employeeCode}`}
                      >
                        <UserMinus size={14} />
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="border-t px-4 py-2 text-xs text-gray-500" data-testid="drawer-showing">
          Showing <b>{shown.length}</b> of {plural(all.length, "employee")}
        </div>
      </SheetContent>
    </Sheet>
  );
}
