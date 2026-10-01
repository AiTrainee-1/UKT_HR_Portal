import { useMemo, useState } from "react";
import { PartyPopper, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { useListEmployees } from "@/lib/api-client";
import { useListShiftAssignments } from "@/lib/api-client/custom-hooks";
import { SearchBox, TypeChips } from "./AssignmentsTab";
import { filterPeople, pluralize, unassignedOf, type Person, type TypeFilter } from "./shift-logic";

/** Active employees who are on no shift. Tick several and assign them together, or assign one from its row. */
export default function UnassignedTab({ onAssign }: { onAssign: (people: Person[]) => void }) {
  const [type, setType] = useState<TypeFilter>("all");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const { data: employees = [], isLoading } = useListEmployees({ status: "active" });
  const { data: assignments = [], isLoading: assignmentsLoading } = useListShiftAssignments({ activeOnly: true });

  const without = useMemo(() => unassignedOf<Person>(employees, assignments), [employees, assignments]);
  const counts: Record<TypeFilter, number> = useMemo(
    () => ({
      all: without.length,
      staff: without.filter((e) => (e.employmentType ?? "staff") === "staff").length,
      production: without.filter((e) => e.employmentType === "production").length,
    }),
    [without],
  );
  const list = useMemo(() => filterPeople(without, type, query), [without, type, query]);
  const chosen = list.filter((e) => picked.has(e.id));
  const all = list.length > 0 && chosen.length === list.length;
  const toggle = (id: number) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (isLoading || assignmentsLoading) {
    return (
      <div className="space-y-2">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-14 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="unassigned-tab">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <TypeChips value={type} onChange={setType} counts={counts} />
        <SearchBox
          value={query}
          onChange={setQuery}
          placeholder="Search name, code or department…"
          testId="unassigned-search"
        />
      </div>

      {list.length === 0 ? (
        <Card className="flex flex-col items-center border-0 py-16 text-center shadow-sm">
          <PartyPopper size={34} className="mb-3 text-emerald-400" />
          <p className="font-semibold text-gray-700">
            {query || type !== "all" ? "Nobody matches your filters" : "Every active employee has a shift"}
          </p>
        </Card>
      ) : (
        <Card className="overflow-hidden border-0 shadow-sm">
          <div className="flex flex-wrap items-center gap-3 border-b bg-red-50/40 px-4 py-2.5">
            <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-gray-700">
              <Checkbox
                checked={all}
                onCheckedChange={() => setPicked(all ? new Set() : new Set(list.map((e) => e.id)))}
                aria-label="Select everyone listed"
                data-testid="unassigned-select-all"
              />
              {chosen.length > 0
                ? `${chosen.length} selected`
                : `${pluralize(list.length, "employee")} without a shift`}
            </label>
            {chosen.length > 0 && (
              <Button
                size="sm"
                className="ml-auto h-8 gap-1.5 text-xs"
                onClick={() => onAssign(chosen)}
                data-testid="unassigned-assign-selected"
              >
                <UserPlus size={13} /> Assign selected
              </Button>
            )}
          </div>
          <ul className="divide-y">
            {list.slice(0, 200).map((e) => (
              <li
                key={e.id}
                className={`flex items-center gap-3 px-4 py-2.5 ${picked.has(e.id) ? "bg-blue-50/50" : ""}`}
                data-testid={`unassigned-row-${e.employeeCode}`}
              >
                <Checkbox
                  checked={picked.has(e.id)}
                  onCheckedChange={() => toggle(e.id)}
                  aria-label={`Select ${e.firstName} ${e.lastName ?? ""}`}
                  data-testid={`unassigned-select-${e.employeeCode}`}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-gray-900">
                    {e.firstName} {e.lastName}
                    <span className="ml-2 font-mono text-[11px] font-normal text-gray-400">{e.employeeCode}</span>
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {[e.departmentName, e.designationTitle].filter(Boolean).join(" · ") || "No department"}
                  </p>
                </div>
                <StatusBadge
                  tone={e.employmentType === "production" ? "warning" : "success"}
                  className="hidden capitalize sm:inline-flex"
                >
                  {e.employmentType ?? "staff"}
                </StatusBadge>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 shrink-0 gap-1.5 text-xs"
                  onClick={() => onAssign([e])}
                  data-testid={`unassigned-assign-${e.employeeCode}`}
                >
                  <UserPlus size={12} /> Assign shift
                </Button>
              </li>
            ))}
          </ul>
          {list.length > 200 && (
            <p className="border-t px-4 py-2.5 text-center text-xs text-muted-foreground">
              Showing 200 of {list.length}. Search to narrow the list.
            </p>
          )}
        </Card>
      )}
    </div>
  );
}
