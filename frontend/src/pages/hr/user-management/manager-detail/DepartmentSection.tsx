import { useMemo, useState } from "react";
import { Building2, ChevronDown, RotateCcw, Search, UserMinus, UserPlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { StatusBadge } from "@/components/ui/status-badge";
import { ToastAction } from "@/components/ui/toast";
import { useToast } from "@/hooks/use-toast";
import {
  useExcludeEmployees,
  useRestoreEmployees,
  type RosterDepartment,
  type RosterEmployee,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import {
  PAGE_SIZE,
  ROSTER_FILTERS,
  STATE_META,
  canClaim,
  canRemove,
  canRestore,
  departmentSummary,
  filterCounts,
  filterRoster,
  isActive,
  pageSlice,
  removable,
  rowDetail,
  type RosterFilter,
} from "../roster";

const AVATAR: Record<RosterEmployee["state"], string> = {
  reporting: "bg-blue-100 text-blue-700",
  self: "bg-indigo-100 text-indigo-700",
  removed: "bg-gray-200 text-gray-500",
  elsewhere: "bg-amber-100 text-amber-700",
};

function Row({
  employee: e,
  managerName,
  selected,
  busy,
  onSelect,
  onRemove,
  onRestore,
  onClaim,
}: {
  employee: RosterEmployee;
  managerName: string;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onRemove: () => void;
  onRestore: () => void;
  onClaim: () => void;
}) {
  const meta = STATE_META[e.state];
  const removed = e.state === "removed";
  return (
    <li
      className={cn(
        "flex items-center gap-3 px-3 py-2.5 sm:px-4",
        removed && "bg-gray-50/70",
        selected && "bg-blue-50/50",
      )}
      data-testid={`roster-row-${e.employeeCode}`}
      data-state={e.state}
    >
      <div className="flex w-5 shrink-0 justify-center">
        {canRemove(e) && (
          <Checkbox
            checked={selected}
            onCheckedChange={onSelect}
            aria-label={`Select ${e.name}`}
            data-testid={`roster-select-${e.employeeCode}`}
          />
        )}
      </div>
      <span
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-sm font-black",
          AVATAR[e.state],
        )}
      >
        {e.name.charAt(0)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span
            className={cn(
              "truncate text-sm font-semibold",
              removed ? "text-gray-400 line-through decoration-gray-300" : "text-gray-900",
            )}
          >
            {e.name}
          </span>
          <code className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[11px] text-gray-600">
            {e.employeeCode}
          </code>
          {!isActive(e) && <StatusBadge tone="neutral">Inactive</StatusBadge>}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
          <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>
          {e.individual && e.state === "reporting" && (
            <StatusBadge tone="info" className="font-semibold">
              Also assigned individually
            </StatusBadge>
          )}
          {rowDetail(e) && <span className="min-w-0 text-xs text-muted-foreground">{rowDetail(e)}</span>}
        </div>
      </div>
      <div className="shrink-0">
        {canRemove(e) && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 px-2 text-xs font-semibold text-red-600 hover:bg-red-50 hover:text-red-700"
            onClick={onRemove}
            disabled={busy}
            aria-label={`Remove ${e.name} from ${managerName}`}
            title="Remove from this HOD (they stay in the department)"
            data-testid={`roster-remove-${e.employeeCode}`}
          >
            <UserMinus size={14} />
            <span className="hidden sm:inline">Remove</span>
          </Button>
        )}
        {canRestore(e) && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 px-2 text-xs font-semibold text-blue-600 hover:bg-blue-50 hover:text-blue-700"
            onClick={onRestore}
            disabled={busy}
            aria-label={`Restore ${e.name} to ${managerName}`}
            title="Put back under this HOD"
            data-testid={`roster-restore-${e.employeeCode}`}
          >
            <RotateCcw size={14} />
            <span className="hidden sm:inline">Restore</span>
          </Button>
        )}
        {canClaim(e) && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 px-2 text-xs font-semibold text-gray-600"
            onClick={onClaim}
            disabled={busy}
            aria-label={`Assign ${e.name} to ${managerName}`}
            title="Move them from their current HOD to this one"
            data-testid={`roster-claim-${e.employeeCode}`}
          >
            <UserPlus size={14} />
            <span className="hidden sm:inline">Assign here</span>
          </Button>
        )}
      </div>
    </li>
  );
}

/**
 * One department the HOD covers, with everyone in it listed automatically (people who join later appear on their own).
 * HR removes someone to stop them reporting to this HOD (they stay in the department; their requests go to the next
 * HOD who holds it, or to HR) and restores them the same way. Searchable, filterable, with bulk removal and an Undo.
 */
export default function DepartmentSection({
  managerId,
  managerName,
  department,
  open,
  onToggle,
  onRemoveDepartment,
  onClaim,
  claimingId,
}: {
  managerId: number;
  managerName: string;
  department: RosterDepartment;
  open: boolean;
  onToggle: () => void;
  onRemoveDepartment: () => void;
  onClaim: (e: RosterEmployee) => void;
  claimingId: number | null;
}) {
  const { toast } = useToast();
  const exclude = useExcludeEmployees();
  const restore = useRestoreEmployees();
  const [filter, setFilter] = useState<RosterFilter>("all");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [shown, setShown] = useState(PAGE_SIZE);

  const counts = useMemo(() => filterCounts(department.employees), [department.employees]);
  const rows = useMemo(() => filterRoster(department.employees, filter, query), [department.employees, filter, query]);
  const { rows: visible, hidden } = pageSlice(rows, shown);
  const removableRows = removable(rows);
  // Only people who can still be removed count as selected (a list that refreshed under the cursor drops the rest).
  const selectedRows = removableRows.filter((e) => picked.has(e.employeeId));
  const busy = exclude.isPending || restore.isPending;

  const failed = (title: string, e: unknown) =>
    toast({
      title,
      description: e instanceof Error ? e.message : undefined,
      variant: "destructive",
    });

  const putBack = async (ids: number[]) => {
    try {
      const res = await restore.mutateAsync({ managerId, employeeIds: ids });
      toast({
        title: res.message,
        description:
          res.reportingElsewhere.length > 0
            ? `${res.reportingElsewhere.length} of them now report to another HOD, so they still show as "Another HOD".`
            : undefined,
      });
    } catch (e) {
      failed("Could not restore", e);
    }
  };

  const takeOut = async (people: RosterEmployee[]) => {
    const ids = people.map((p) => p.employeeId);
    try {
      const res = await exclude.mutateAsync({ managerId, employeeIds: ids });
      setPicked(new Set());
      const who = people.length === 1 ? people[0].name : `${people.length} employees`;
      toast({
        title: `${who} removed from ${managerName}`,
        description: `They stay in ${department.name}. Their requests go to the next HOD who holds it, or to HR.${
          res.alsoUnassigned ? " Their individual assignment was removed too." : ""
        }`,
        action: (
          <ToastAction altText="Undo" onClick={() => void putBack(ids)}>
            Undo
          </ToastAction>
        ),
      });
    } catch (e) {
      failed("Could not remove", e);
    }
  };

  const toggleOne = (id: number) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allSelected = removableRows.length > 0 && selectedRows.length === removableRows.length;

  return (
    <div
      className="overflow-hidden rounded-2xl border bg-white"
      data-testid={`dept-section-${department.id}`}
      data-open={open}
    >
      <div className="flex items-center gap-1 pr-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-gray-50/70 sm:px-4"
          data-testid={`dept-toggle-${department.id}`}
        >
          <ChevronDown size={16} className={cn("shrink-0 text-gray-400 transition-transform", !open && "-rotate-90")} />
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-100 text-indigo-600">
            <Building2 size={17} />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-bold text-gray-900">{department.name}</span>
            <span
              className="block truncate text-xs text-muted-foreground"
              data-testid={`dept-summary-${department.id}`}
            >
              {departmentSummary(department.counts)}
            </span>
          </span>
        </button>
        <button
          type="button"
          onClick={onRemoveDepartment}
          aria-label={`Remove department ${department.name}`}
          title="Remove this department from the HOD"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-red-50 hover:text-red-600"
          data-testid={`dept-remove-${department.id}`}
        >
          <X size={16} />
        </button>
      </div>

      {open && (
        <div className="border-t">
          {department.employees.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              Nobody is in this department yet. People who join it are listed here automatically.
            </p>
          ) : (
            <>
              <div className="space-y-3 p-3 sm:p-4">
                <div className="flex flex-col gap-2.5 lg:flex-row lg:items-center lg:justify-between">
                  <div className="flex h-9 w-full items-center gap-2 rounded-lg border bg-background px-3 focus-within:border-primary/60 focus-within:ring-2 focus-within:ring-primary/15 lg:w-72">
                    <Search size={14} className="shrink-0 text-muted-foreground" aria-hidden />
                    <input
                      value={query}
                      onChange={(e) => {
                        setQuery(e.target.value);
                        setShown(PAGE_SIZE);
                      }}
                      placeholder={`Search ${department.name}…`}
                      aria-label={`Search ${department.name}`}
                      className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                      data-testid={`dept-search-${department.id}`}
                    />
                  </div>
                  <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter employees">
                    {ROSTER_FILTERS.map((f) => (
                      <button
                        key={f.value}
                        type="button"
                        aria-pressed={filter === f.value}
                        onClick={() => {
                          setFilter(f.value);
                          setShown(PAGE_SIZE);
                        }}
                        data-testid={`dept-filter-${department.id}-${f.value}`}
                        className={cn(
                          "rounded-full border px-3 py-1 text-xs font-semibold transition-colors",
                          filter === f.value
                            ? "border-blue-200 bg-blue-50 text-blue-700"
                            : "border-gray-200 bg-white text-gray-500 hover:border-gray-300 hover:text-gray-800",
                        )}
                      >
                        {f.label} <span className="ml-0.5 opacity-60">{counts[f.value]}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {removableRows.length > 0 && (
                  <div
                    className={cn(
                      "flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg px-3 py-2 text-xs",
                      selectedRows.length > 0 ? "bg-blue-50" : "bg-gray-50",
                    )}
                  >
                    <label className="flex cursor-pointer items-center gap-2 font-medium text-gray-700">
                      <Checkbox
                        checked={allSelected}
                        onCheckedChange={() =>
                          setPicked(allSelected ? new Set() : new Set(removableRows.map((e) => e.employeeId)))
                        }
                        aria-label={`Select all ${removableRows.length} listed`}
                        data-testid={`dept-select-all-${department.id}`}
                      />
                      {selectedRows.length > 0
                        ? `${selectedRows.length} selected`
                        : `Select all ${removableRows.length}`}
                    </label>
                    {selectedRows.length > 0 && (
                      <div className="ml-auto flex items-center gap-1.5">
                        <Button
                          size="sm"
                          variant="destructive"
                          className="h-7 gap-1.5 px-2.5 text-xs"
                          onClick={() => void takeOut(selectedRows)}
                          disabled={busy}
                          data-testid={`dept-remove-selected-${department.id}`}
                        >
                          <UserMinus size={13} /> Remove selected
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-xs"
                          onClick={() => setPicked(new Set())}
                        >
                          Clear
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {rows.length === 0 ? (
                <p className="border-t px-4 py-8 text-center text-sm text-muted-foreground">
                  {query.trim() ? `Nobody in ${department.name} matches “${query.trim()}”.` : "Nobody to show here."}
                </p>
              ) : (
                <ul className="divide-y border-t" data-testid={`dept-list-${department.id}`}>
                  {visible.map((e) => (
                    <Row
                      key={e.employeeId}
                      employee={e}
                      managerName={managerName}
                      selected={picked.has(e.employeeId)}
                      busy={busy || claimingId === e.employeeId}
                      onSelect={() => toggleOne(e.employeeId)}
                      onRemove={() => void takeOut([e])}
                      onRestore={() => void putBack([e.employeeId])}
                      onClaim={() => onClaim(e)}
                    />
                  ))}
                </ul>
              )}
              {hidden > 0 && (
                <button
                  type="button"
                  onClick={() => setShown((n) => n + PAGE_SIZE)}
                  className="w-full border-t py-2.5 text-xs font-semibold text-blue-600 transition-colors hover:bg-blue-50/60"
                  data-testid={`dept-more-${department.id}`}
                >
                  Show {Math.min(hidden, PAGE_SIZE)} more ({hidden} hidden)
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
