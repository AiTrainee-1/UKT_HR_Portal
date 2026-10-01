import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRightLeft,
  BarChart2,
  ChevronDown,
  Clock,
  Factory,
  Pencil,
  Search,
  UserMinus,
  UserPlus,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { useListShiftAssignments, type ShiftAssignment } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import EmployeeShiftStatsDialog from "./EmployeeShiftStatsDialog";
import { EditScheduleDialog, RemoveFromShiftDialog } from "./ManageAssignmentDialogs";
import {
  filterAssignments,
  groupAssignments,
  pluralize,
  prettyDate,
  type AssignedGroup,
  type TypeFilter,
} from "./shift-logic";

const PAGE = 50;

export function TypeChips({
  value,
  onChange,
  counts,
}: {
  value: TypeFilter;
  onChange: (v: TypeFilter) => void;
  counts: Record<TypeFilter, number>;
}) {
  const chips: { v: TypeFilter; label: string }[] = [
    { v: "all", label: "All" },
    { v: "staff", label: "Staff" },
    { v: "production", label: "Production" },
  ];
  return (
    <div className="inline-flex rounded-full bg-gray-100 p-0.5" role="group" aria-label="Filter by employee type">
      {chips.map((c) => (
        <button
          key={c.v}
          type="button"
          aria-pressed={value === c.v}
          onClick={() => onChange(c.v)}
          data-testid={`type-chip-${c.v}`}
          className={cn(
            "rounded-full px-3 py-1 text-xs font-semibold transition-colors",
            value === c.v ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-800",
          )}
        >
          {c.label} <span className="ml-0.5 text-gray-400">{counts[c.v]}</span>
        </button>
      ))}
    </div>
  );
}

export function SearchBox({
  value,
  onChange,
  placeholder,
  testId,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  testId: string;
}) {
  return (
    <div className="flex h-9 w-full items-center gap-2 rounded-lg border bg-background px-3 shadow-sm focus-within:border-primary/60 focus-within:ring-2 focus-within:ring-primary/15 sm:w-72">
      <Search size={14} className="shrink-0 text-muted-foreground" aria-hidden />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        data-testid={testId}
      />
    </div>
  );
}

function GroupCard({
  group,
  open,
  onToggle,
  onAssign,
  onMove,
  onRemove,
  onEdit,
  onStats,
}: {
  group: AssignedGroup;
  open: boolean;
  onToggle: () => void;
  onAssign: () => void;
  onMove: (people: ShiftAssignment[]) => void;
  onRemove: (people: ShiftAssignment[]) => void;
  onEdit: (p: ShiftAssignment) => void;
  onStats: (p: ShiftAssignment) => void;
}) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [shown, setShown] = useState(PAGE);
  const production = group.shiftType === "production";

  const q = query.trim().toLowerCase();
  const members = group.members.filter(
    (m) =>
      !q ||
      m.employeeName.toLowerCase().includes(q) ||
      m.employeeCode.toLowerCase().includes(q) ||
      (m.departmentName ?? "").toLowerCase().includes(q),
  );
  const chosen = members.filter((m) => picked.has(m.id));
  const all = members.length > 0 && chosen.length === members.length;
  const toggleOne = (id: number) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Card className="overflow-hidden border-0 shadow-sm" data-testid={`group-${group.shiftId}`} data-open={open}>
      <div className="flex items-center gap-1 pr-3">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-3 p-4 text-left transition-colors hover:bg-gray-50/60"
          data-testid={`group-toggle-${group.shiftId}`}
        >
          <span
            className={cn(
              "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-white",
              production
                ? "bg-gradient-to-br from-amber-400 to-orange-500"
                : "bg-gradient-to-br from-emerald-400 to-emerald-600",
            )}
          >
            {production ? <Factory size={18} /> : <Users size={18} />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="truncate text-sm font-bold text-gray-900">{group.shiftName}</span>
              <StatusBadge tone={production ? "warning" : "success"} className="capitalize">
                {group.shiftType}
              </StatusBadge>
              {group.genderRule !== "all" && (
                <StatusBadge tone="accent" className="capitalize">
                  {group.genderRule} only
                </StatusBadge>
              )}
            </span>
            <span className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
              <Clock size={11} /> {group.startTime}–{group.endTime} · grace {group.gracePeriodMinutes} min
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-2">
            <span
              className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-bold text-gray-700"
              data-testid={`group-count-${group.shiftId}`}
            >
              {group.members.length}
            </span>
            <ChevronDown size={16} className={cn("text-gray-400 transition-transform", !open && "-rotate-90")} />
          </span>
        </button>
        <Button
          variant="outline"
          size="sm"
          className="hidden h-8 shrink-0 gap-1.5 text-xs sm:inline-flex"
          onClick={onAssign}
          data-testid={`group-assign-${group.shiftId}`}
        >
          <UserPlus size={13} /> Assign people
        </Button>
      </div>

      {open && (
        <div className="border-t">
          <div className="flex flex-wrap items-center gap-2 bg-gray-50/60 px-4 py-2.5">
            <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-gray-700">
              <Checkbox
                checked={all}
                onCheckedChange={() => setPicked(all ? new Set() : new Set(members.map((m) => m.id)))}
                aria-label={`Select everyone on ${group.shiftName}`}
                data-testid={`group-select-all-${group.shiftId}`}
              />
              {chosen.length > 0 ? `${chosen.length} selected` : "Select all"}
            </label>
            {chosen.length > 0 ? (
              <div className="ml-auto flex items-center gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1.5 text-xs"
                  onClick={() => onMove(chosen)}
                  aria-label="Assign the selected employees to another shift"
                  data-testid={`group-move-${group.shiftId}`}
                >
                  <ArrowRightLeft size={12} /> Move selected
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  className="h-7 gap-1.5 text-xs"
                  onClick={() => onRemove(chosen)}
                  data-testid={`group-remove-${group.shiftId}`}
                >
                  <UserMinus size={12} /> Remove selected
                </Button>
              </div>
            ) : (
              group.members.length > 5 && (
                <div className="ml-auto">
                  <SearchBox
                    value={query}
                    onChange={setQuery}
                    placeholder="Filter this shift…"
                    testId={`group-search-${group.shiftId}`}
                  />
                </div>
              )
            )}
          </div>
          {members.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">Nobody matches.</p>
          ) : (
            <ul className="divide-y">
              {members.slice(0, shown).map((m) => (
                <li
                  key={m.id}
                  className={cn("flex items-center gap-3 px-4 py-2.5", picked.has(m.id) && "bg-blue-50/50")}
                  data-testid={`member-${m.employeeCode}`}
                >
                  <Checkbox
                    checked={picked.has(m.id)}
                    onCheckedChange={() => toggleOne(m.id)}
                    aria-label={`Select ${m.employeeName}`}
                    data-testid={`member-select-${m.employeeCode}`}
                  />
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-400 to-indigo-500 text-xs font-bold text-white">
                    {m.employeeName.charAt(0).toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-gray-900">{m.employeeName}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {[m.employeeCode, m.departmentName, m.designationTitle].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                  <div className="hidden shrink-0 items-center gap-1.5 md:flex">
                    {(m.customStartTime || m.customEndTime) && (
                      <StatusBadge tone="info" className="font-semibold">
                        {m.customStartTime ?? m.startTime}–{m.customEndTime ?? m.endTime}
                      </StatusBadge>
                    )}
                    {m.saturdayOff && <StatusBadge tone="info">Sat off</StatusBadge>}
                    <span className="text-xs text-muted-foreground">since {prettyDate(m.effectiveFrom)}</span>
                  </div>
                  <div className="flex shrink-0 items-center">
                    {(
                      [
                        ["View attendance history", BarChart2, () => onStats(m), "stats"],
                        ["Assign to another shift", ArrowRightLeft, () => onMove([m]), "move"],
                        ["Edit schedule", Pencil, () => onEdit(m), "edit"],
                        ["Remove from shift", UserMinus, () => onRemove([m]), "remove"],
                      ] as const
                    ).map(([label, Icon, run, key]) => (
                      <button
                        key={key}
                        type="button"
                        onClick={run}
                        aria-label={`${label}: ${m.employeeName}`}
                        title={label}
                        data-testid={`member-${key}-${m.employeeCode}`}
                        className={cn(
                          "flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700",
                          key === "remove" && "hover:bg-red-50 hover:text-red-600",
                        )}
                      >
                        <Icon size={14} />
                      </button>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {members.length > shown && (
            <button
              type="button"
              onClick={() => setShown((n) => n + PAGE)}
              className="w-full border-t py-2.5 text-xs font-semibold text-blue-600 hover:bg-blue-50/60"
            >
              Show {Math.min(PAGE, members.length - shown)} more ({members.length - shown} hidden)
            </button>
          )}
        </div>
      )}
    </Card>
  );
}

/**
 * Who is on which shift, grouped by shift. From here HR can look at an employee's attendance on their shift, move people
 * to another shift (the assign dialog, pre-filled and set to reassign), change one person's own hours, or take people
 * off a shift from a chosen last day.
 */
export default function AssignmentsTab({
  focusShiftId,
  onAssignToShift,
  onMove,
}: {
  /** Open this shift's card (coming from "N employees" on a shift). */
  focusShiftId: number | null;
  onAssignToShift: (shiftId: number) => void;
  onMove: (people: ShiftAssignment[]) => void;
}) {
  const [type, setType] = useState<TypeFilter>("all");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [removing, setRemoving] = useState<ShiftAssignment[]>([]);
  const [editing, setEditing] = useState<ShiftAssignment | null>(null);
  const [stats, setStats] = useState<ShiftAssignment | null>(null);
  const { data = [], isLoading } = useListShiftAssignments({ activeOnly: true });
  const focused = useRef<number | null>(null);

  useEffect(() => {
    if (focusShiftId !== null && focused.current !== focusShiftId) {
      focused.current = focusShiftId;
      setOpen((s) => new Set(s).add(focusShiftId));
      setType("all");
      setQuery("");
      requestAnimationFrame(() =>
        document
          .querySelector(`[data-testid="group-${focusShiftId}"]`)
          ?.scrollIntoView({ behavior: "smooth", block: "nearest" }),
      );
    }
  }, [focusShiftId, data.length]);

  const counts: Record<TypeFilter, number> = useMemo(
    () => ({
      all: data.length,
      staff: data.filter((a) => (a.employmentType ?? "staff") === "staff").length,
      production: data.filter((a) => a.employmentType === "production").length,
    }),
    [data],
  );
  const groups = useMemo(() => groupAssignments(filterAssignments(data, type, query)), [data, type, query]);
  const toggle = (id: number) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="space-y-4" data-testid="assignments-tab">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <TypeChips value={type} onChange={setType} counts={counts} />
        <SearchBox
          value={query}
          onChange={setQuery}
          placeholder="Search employee, code or shift…"
          testId="assignments-search"
        />
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Card key={i} className="flex items-center gap-4 border-0 p-4 shadow-sm">
              <Skeleton className="h-11 w-11 rounded-xl" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-60" />
              </div>
            </Card>
          ))}
        </div>
      ) : groups.length === 0 ? (
        <Card className="flex flex-col items-center border-0 py-16 text-center shadow-sm">
          <Users size={34} className="mb-3 text-muted-foreground/30" />
          <p className="font-semibold text-gray-700">
            {query || type !== "all" ? "Nobody matches your filters" : "Nobody has a shift yet"}
          </p>
          {!(query || type !== "all") && (
            <p className="mt-1 text-sm text-muted-foreground">
              Create a shift on the Shifts tab, then assign people to it.
            </p>
          )}
        </Card>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            {pluralize(
              groups.reduce((n, g) => n + g.members.length, 0),
              "employee",
            )}{" "}
            on {pluralize(groups.length, "shift")}
          </p>
          {groups.map((g) => (
            <GroupCard
              key={g.shiftId}
              group={g}
              open={open.has(g.shiftId)}
              onToggle={() => toggle(g.shiftId)}
              onAssign={() => onAssignToShift(g.shiftId)}
              onMove={onMove}
              onRemove={setRemoving}
              onEdit={setEditing}
              onStats={setStats}
            />
          ))}
        </div>
      )}

      {removing.length > 0 && <RemoveFromShiftDialog people={removing} onClose={() => setRemoving([])} />}
      {editing && <EditScheduleDialog person={editing} onClose={() => setEditing(null)} />}
      {stats && (
        <EmployeeShiftStatsDialog
          employeeId={stats.employeeId}
          employeeName={stats.employeeName}
          onClose={() => setStats(null)}
        />
      )}
    </div>
  );
}
