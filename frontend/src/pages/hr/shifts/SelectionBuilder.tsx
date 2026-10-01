import { useMemo, useState } from "react";
import { Briefcase, Building2, Check, Search, User, X } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import type { ShiftType } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import {
  KIND_LABEL,
  flipRule,
  removeRule,
  ruleCounts,
  ruleOf,
  setRule,
  type Person,
  type Rule,
  type RuleKind,
  type RuleMode,
} from "./shift-logic";

export type PickerDepartment = { id: number; name: string };
export type PickerDesignation = { id: number; title: string; departmentName?: string | null };

const KIND_ICON = { employee: User, department: Building2, designation: Briefcase } as const;
const SHOWN = 40;

function ModeButtons({
  mode,
  onPick,
  label,
  testKey,
}: {
  mode: RuleMode | undefined;
  onPick: (m: RuleMode) => void;
  label: string;
  testKey: string;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      <button
        type="button"
        onClick={() => onPick("include")}
        aria-pressed={mode === "include"}
        aria-label={`Include ${label}`}
        title={mode === "include" ? "Included. Click to remove" : "Include"}
        data-testid={`sel-include-${testKey}`}
        className={cn(
          "inline-flex h-7 items-center gap-1 rounded-lg border px-2 text-xs font-semibold transition-colors",
          mode === "include"
            ? "border-emerald-600 bg-emerald-600 text-white"
            : "border-gray-200 bg-white text-gray-600 hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700",
        )}
      >
        {mode === "include" && <Check size={12} />} Include
      </button>
      <button
        type="button"
        onClick={() => onPick("exclude")}
        aria-pressed={mode === "exclude"}
        aria-label={`Exclude ${label}`}
        title={mode === "exclude" ? "Excluded. Click to remove" : "Leave out"}
        data-testid={`sel-exclude-${testKey}`}
        className={cn(
          "inline-flex h-7 items-center gap-1 rounded-lg border px-2 text-xs font-semibold transition-colors",
          mode === "exclude"
            ? "border-red-600 bg-red-600 text-white"
            : "border-gray-200 bg-white text-gray-600 hover:border-red-300 hover:bg-red-50 hover:text-red-700",
        )}
      >
        {mode === "exclude" && <X size={12} />} Exclude
      </button>
    </div>
  );
}

function Chip({ rule, onFlip, onRemove }: { rule: Rule; onFlip: () => void; onRemove: () => void }) {
  const Icon = KIND_ICON[rule.kind];
  const inc = rule.mode === "include";
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-full border py-0.5 pl-2 pr-0.5 text-xs font-semibold",
        inc ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-red-200 bg-red-50 text-red-800",
      )}
      data-testid={`chip-${rule.kind}-${rule.id}`}
      data-mode={rule.mode}
    >
      <Icon size={12} className="shrink-0" />
      <span className="truncate">{rule.label}</span>
      <button
        type="button"
        onClick={onFlip}
        title={inc ? "Change to exclude" : "Change to include"}
        aria-label={`${inc ? "Exclude" : "Include"} ${rule.label} instead`}
        data-testid={`chip-flip-${rule.kind}-${rule.id}`}
        className={cn(
          "rounded-full px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide",
          inc ? "bg-emerald-600 text-white hover:bg-emerald-700" : "bg-red-600 text-white hover:bg-red-700",
        )}
      >
        {inc ? "Include" : "Exclude"}
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${rule.label}`}
        data-testid={`chip-remove-${rule.kind}-${rule.id}`}
        className="flex h-5 w-5 items-center justify-center rounded-full text-current opacity-60 hover:bg-black/5 hover:opacity-100"
      >
        <X size={12} />
      </button>
    </span>
  );
}

/**
 * Choose who gets the shift: any number of employees, departments and designations, each INCLUDED or EXCLUDED. An
 * employee is picked when they match any included item; whatever is excluded is always left out. The server works out
 * the real list (see shift_planner.py); this only builds the rules, and the preview beside it shows the outcome.
 */
export default function SelectionBuilder({
  shiftType,
  rules,
  onRules,
  includeAll,
  onIncludeAll,
  employees,
  departments,
  designations,
  currentShift,
}: {
  shiftType: ShiftType | null;
  rules: Rule[];
  onRules: (rules: Rule[]) => void;
  includeAll: boolean;
  onIncludeAll: (v: boolean) => void;
  employees: Person[];
  departments: PickerDepartment[];
  designations: PickerDesignation[];
  /** employeeId -> the name of the shift they are on now, shown beside them. */
  currentShift: Map<number, string>;
}) {
  const [kind, setKind] = useState<RuleKind>("employee");
  const [query, setQuery] = useState("");

  // Only people the shift can go to are offered: a staff shift cannot be given to a production employee.
  const eligible = useMemo(
    () => employees.filter((e) => !shiftType || (e.employmentType ?? "staff") === shiftType),
    [employees, shiftType],
  );
  const q = query.trim().toLowerCase();

  const deptCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of eligible) m.set(e.departmentName ?? "", (m.get(e.departmentName ?? "") ?? 0) + 1);
    return m;
  }, [eligible]);
  const desigCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of eligible) m.set(e.designationTitle ?? "", (m.get(e.designationTitle ?? "") ?? 0) + 1);
    return m;
  }, [eligible]);

  type Item = { id: number; label: string; sub: string; shiftName?: string };
  const items: Item[] = useMemo(() => {
    if (kind === "employee") {
      return eligible
        .filter(
          (e) =>
            !q ||
            `${e.firstName} ${e.lastName ?? ""}`.toLowerCase().includes(q) ||
            e.employeeCode.toLowerCase().includes(q) ||
            (e.departmentName ?? "").toLowerCase().includes(q) ||
            (e.designationTitle ?? "").toLowerCase().includes(q),
        )
        .map((e) => ({
          id: e.id,
          label: `${e.firstName} ${e.lastName ?? ""}`.trim(),
          sub: [e.employeeCode, e.departmentName, e.designationTitle].filter(Boolean).join(" · "),
          shiftName: currentShift.get(e.id),
        }));
    }
    if (kind === "department") {
      return departments
        .filter((d) => !q || d.name.toLowerCase().includes(q))
        .map((d) => ({
          id: d.id,
          label: d.name,
          sub: `${deptCount.get(d.name) ?? 0} ${shiftType ?? ""} employee${(deptCount.get(d.name) ?? 0) === 1 ? "" : "s"}`.replace(
            "  ",
            " ",
          ),
        }));
    }
    return designations
      .filter((d) => !q || d.title.toLowerCase().includes(q) || (d.departmentName ?? "").toLowerCase().includes(q))
      .map((d) => ({
        id: d.id,
        label: d.title,
        sub: [d.departmentName, `${desigCount.get(d.title) ?? 0} ${shiftType ?? ""} employees`.replace("  ", " ")]
          .filter(Boolean)
          .join(" · "),
      }));
  }, [kind, eligible, q, departments, designations, deptCount, desigCount, currentShift, shiftType]);

  const shown = items.slice(0, SHOWN);
  const counts = ruleCounts(rules);
  const included = rules.filter((r) => r.mode === "include");
  const excluded = rules.filter((r) => r.mode === "exclude");

  const pick = (item: Item, mode: RuleMode) => {
    const existing = ruleOf(rules, kind, item.id);
    // pressing the mode it already has takes it off again
    if (existing?.mode === mode) onRules(removeRule(rules, kind, item.id));
    else onRules(setRule(rules, { kind, id: item.id, label: item.label, sub: item.sub, mode }));
  };

  const tabs: { kind: RuleKind; label: string }[] = [
    { kind: "employee", label: "Employees" },
    { kind: "department", label: "Departments" },
    { kind: "designation", label: "Designations" },
  ];

  return (
    <div className="space-y-3" data-testid="selection-builder">
      <label
        className={cn(
          "flex cursor-pointer items-center justify-between gap-3 rounded-xl border p-3 transition-colors",
          includeAll ? "border-primary/40 bg-primary/5" : "border-gray-200 bg-white",
          !shiftType && "cursor-not-allowed opacity-60",
        )}
      >
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-gray-900">
            Everyone {shiftType ? `on ${shiftType} pay` : "of the shift's type"}
          </span>
          <span className="block text-xs text-muted-foreground">
            Start from all {shiftType ?? "matching"} employees, then exclude departments, designations or people below.
          </span>
        </span>
        <Switch
          checked={includeAll}
          onCheckedChange={onIncludeAll}
          disabled={!shiftType}
          aria-label="Include every employee of this shift's type"
          data-testid="sel-all-toggle"
        />
      </label>

      <div className="overflow-hidden rounded-2xl border bg-white">
        <div className="flex gap-1 border-b bg-gray-50/70 p-1.5" role="tablist" aria-label="What to add">
          {tabs.map((t) => {
            const Icon = KIND_ICON[t.kind];
            const n = counts.byKind[t.kind];
            return (
              <button
                key={t.kind}
                type="button"
                role="tab"
                aria-selected={kind === t.kind}
                onClick={() => {
                  setKind(t.kind);
                  setQuery("");
                }}
                data-testid={`sel-kind-${t.kind}`}
                className={cn(
                  "flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-semibold transition-colors",
                  kind === t.kind ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-800",
                )}
              >
                <Icon size={13} />
                <span className="truncate">{t.label}</span>
                {n > 0 && (
                  <span className="rounded-full bg-primary px-1.5 text-[10px] text-primary-foreground">{n}</span>
                )}
              </button>
            );
          })}
        </div>

        <div className="p-2.5">
          <div className="flex h-9 items-center gap-2 rounded-lg border bg-background px-2.5 focus-within:border-primary/60 focus-within:ring-2 focus-within:ring-primary/15">
            <Search size={14} className="shrink-0 text-muted-foreground" aria-hidden />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${KIND_LABEL[kind].many}…`}
              aria-label={`Search ${KIND_LABEL[kind].many}`}
              className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              data-testid="sel-search"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear search"
                className="text-muted-foreground hover:text-foreground"
              >
                <X size={13} />
              </button>
            )}
          </div>

          <ul className="mt-2 max-h-56 divide-y overflow-y-auto rounded-lg border" data-testid="sel-results">
            {shown.length === 0 ? (
              <li className="px-3 py-6 text-center text-xs text-muted-foreground">
                {q ? `Nothing matches “${query.trim()}”.` : `No ${KIND_LABEL[kind].many} to choose from.`}
              </li>
            ) : (
              shown.map((item) => {
                const mode = ruleOf(rules, kind, item.id)?.mode;
                return (
                  <li
                    key={item.id}
                    className={cn(
                      "flex items-center gap-2 px-2.5 py-2",
                      mode === "include" && "bg-emerald-50/50",
                      mode === "exclude" && "bg-red-50/50",
                    )}
                    data-testid={`sel-row-${kind}-${item.id}`}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-gray-900">{item.label}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {item.sub}
                        {item.shiftName && (
                          <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 font-semibold text-amber-800">
                            on {item.shiftName}
                          </span>
                        )}
                      </p>
                    </div>
                    <ModeButtons
                      mode={mode}
                      onPick={(m) => pick(item, m)}
                      label={item.label}
                      testKey={`${kind}-${item.id}`}
                    />
                  </li>
                );
              })
            )}
          </ul>
          {items.length > SHOWN && (
            <p className="mt-1.5 text-center text-[11px] text-muted-foreground">
              Showing {SHOWN} of {items.length}. Type to narrow the list.
            </p>
          )}
        </div>
      </div>

      <div className="space-y-2" data-testid="sel-chips">
        {rules.length === 0 && !includeAll ? (
          <p className="rounded-xl border border-dashed px-3 py-3 text-center text-xs text-muted-foreground">
            Nobody is chosen yet. Include employees, departments or designations above.
          </p>
        ) : (
          <>
            {(includeAll || included.length > 0) && (
              <div>
                <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-emerald-700">
                  Included ({included.length + (includeAll ? 1 : 0)})
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {includeAll && (
                    <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-800">
                      Everyone {shiftType ?? ""}
                    </span>
                  )}
                  {included.map((r) => (
                    <Chip
                      key={`${r.kind}-${r.id}`}
                      rule={r}
                      onFlip={() => onRules(flipRule(rules, r.kind, r.id))}
                      onRemove={() => onRules(removeRule(rules, r.kind, r.id))}
                    />
                  ))}
                </div>
              </div>
            )}
            {excluded.length > 0 && (
              <div>
                <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-red-700">
                  Excluded ({excluded.length})
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {excluded.map((r) => (
                    <Chip
                      key={`${r.kind}-${r.id}`}
                      rule={r}
                      onFlip={() => onRules(flipRule(rules, r.kind, r.id))}
                      onRemove={() => onRules(removeRule(rules, r.kind, r.id))}
                    />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
        <p className="text-[11px] leading-snug text-muted-foreground">
          An employee is picked when they match <b>any</b> included item. Anything excluded is always left out, even if
          an included department or designation contains them.
        </p>
      </div>
    </div>
  );
}
