import { inr } from "@/components/payroll/kit/format";
import { cn } from "@/lib/utils";
import type { DepartmentGroup } from "./department-groups";

const ACTIVE = { indigo: "bg-indigo-600 text-white", amber: "bg-amber-600 text-white" } as const;
const ACTIVE_COUNT = { indigo: "bg-white/20 text-white", amber: "bg-white/20 text-white" } as const;

/**
 * A strip of department tabs: one department's payroll shows at a time. Each tab says how many employees the department has;
 * the line under the strip says which department is open and what its net payable adds up to.
 */
export function DepartmentTabs({
  groups,
  active,
  accent,
  onChange,
  testIdPrefix = "payroll-dept",
}: {
  groups: readonly DepartmentGroup[];
  /** The open department's id (`pickDepartment`). */
  active: string | null;
  accent: "indigo" | "amber";
  onChange: (id: string) => void;
  testIdPrefix?: string;
}) {
  if (groups.length === 0) return null;
  const open = groups.find((g) => g.id === active) ?? groups[0];
  return (
    <div className="space-y-2" data-testid={`${testIdPrefix}-tabs`}>
      <div role="group" aria-label="Department" className="flex flex-wrap gap-1.5">
        {groups.map((g) => {
          const on = g.id === open.id;
          return (
            <button
              key={g.id}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(g.id)}
              className={cn(
                "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors",
                on ? cn("border-transparent shadow-sm", ACTIVE[accent]) : "bg-white text-gray-700 hover:bg-gray-50",
              )}
              data-testid={`${testIdPrefix}-tab-${g.id}`}
            >
              {g.name}
              <span
                className={cn(
                  "rounded-full px-1.5 py-px text-[10px] font-bold tabular-nums",
                  on ? ACTIVE_COUNT[accent] : "bg-gray-100 text-gray-600",
                )}
              >
                {g.count}
              </span>
            </button>
          );
        })}
      </div>
      <p className="text-xs text-gray-500" data-testid={`${testIdPrefix}-summary`}>
        <span className="font-semibold text-gray-800">{open.name}</span> · {open.count}{" "}
        {open.count === 1 ? "employee" : "employees"} · Net payable {inr(open.net)}
      </p>
    </div>
  );
}
