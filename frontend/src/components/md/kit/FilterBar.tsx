import { useState, type ReactNode } from "react";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  COMMON_PRESETS,
  PRESET_LABEL,
  isValidCustom,
  type PeriodChoice,
  type PeriodPreset,
  type ScopeChoice,
} from "@/lib/md/period";
import type { MdOrg } from "@/lib/md/types";
import { cn } from "@/lib/utils";

/** The strip of filters at the top of an analysis page. */
export function FilterBar({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn("flex flex-wrap items-center gap-x-4 gap-y-2.5 rounded-2xl border bg-white p-3", className)}
      data-testid="md-filter-bar"
    >
      {children}
    </div>
  );
}

/** Period presets as pills, plus "Custom" with two dates. Emits a choice only when it is usable. */
export function PeriodBar({
  value,
  onChange,
  presets = COMMON_PRESETS,
  allowCustom = true,
}: {
  value: PeriodChoice;
  onChange: (next: PeriodChoice) => void;
  presets?: PeriodPreset[];
  allowCustom?: boolean;
}) {
  const [customOpen, setCustomOpen] = useState(value.preset === "custom");
  const [from, setFrom] = useState(value.preset === "custom" ? value.from : "");
  const [to, setTo] = useState(value.preset === "custom" ? value.to : "");

  const items = [
    ...presets.map((p) => ({ value: p as string, label: PRESET_LABEL[p] })),
    ...(allowCustom ? [{ value: "custom", label: "Custom" }] : []),
  ];

  const apply = (nextFrom: string, nextTo: string) => {
    if (isValidCustom(nextFrom, nextTo)) onChange({ preset: "custom", from: nextFrom, to: nextTo });
  };

  return (
    <div className="flex max-w-full flex-wrap items-center gap-2" data-testid="period-bar">
      <div className="max-w-full overflow-x-auto">
        <PillTabs
          size="sm"
          items={items}
          value={customOpen ? "custom" : value.preset}
          onChange={(v) => {
            if (v === "custom") {
              setCustomOpen(true);
              apply(from, to);
              return;
            }
            setCustomOpen(false);
            onChange({ preset: v as PeriodPreset });
          }}
        />
      </div>
      {customOpen && (
        <div className="flex items-center gap-1.5 text-xs text-[#006496]/70">
          <Input
            type="date"
            value={from}
            max={to || undefined}
            aria-label="From date"
            data-testid="period-from"
            className="h-8 w-[9.5rem] text-xs"
            onChange={(e) => {
              setFrom(e.target.value);
              apply(e.target.value, to);
            }}
          />
          <span>to</span>
          <Input
            type="date"
            value={to}
            min={from || undefined}
            aria-label="To date"
            data-testid="period-to"
            className="h-8 w-[9.5rem] text-xs"
            onChange={(e) => {
              setTo(e.target.value);
              apply(from, e.target.value);
            }}
          />
        </div>
      )}
    </div>
  );
}

const ALL = "__all__";

/** Unit, department and staff/production selectors. Departments follow the chosen unit; the department is sent by NAME so
 *  a name that exists in several units covers all of them (the server groups them). */
export function ScopeBar({
  value,
  onChange,
  org,
  showDepartment = true,
  showType = true,
}: {
  value: ScopeChoice;
  onChange: (next: ScopeChoice) => void;
  org?: MdOrg;
  showDepartment?: boolean;
  showType?: boolean;
}) {
  const branches = org?.branches ?? [];
  const departmentNames = Array.from(
    new Set(
      (org?.departments ?? []).filter((d) => !value.branch || String(d.branchId) === value.branch).map((d) => d.name),
    ),
  ).sort((a, b) => a.localeCompare(b));

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="scope-bar">
      <Select
        value={value.branch || ALL}
        onValueChange={(v) => {
          const branch = v === ALL ? "" : v;
          // a department that this unit does not have is dropped
          const stillThere =
            !branch ||
            (org?.departments ?? []).some((d) => d.name === value.department && String(d.branchId) === branch);
          onChange({ ...value, branch, department: stillThere ? value.department : "" });
        }}
      >
        <SelectTrigger className="h-8 w-[10.5rem] text-xs" aria-label="Unit" data-testid="scope-branch">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All units</SelectItem>
          {branches.map((b) => (
            <SelectItem key={b.id} value={String(b.id)}>
              {b.name}
              {b.isActive === false ? " (inactive)" : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {showDepartment && (
        <Select
          value={value.department || ALL}
          onValueChange={(v) => onChange({ ...value, department: v === ALL ? "" : v })}
        >
          <SelectTrigger className="h-8 w-[11.5rem] text-xs" aria-label="Department" data-testid="scope-department">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All departments</SelectItem>
            {departmentNames.map((n) => (
              <SelectItem key={n} value={n}>
                {n}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {showType && (
        <Select
          value={value.type || ALL}
          onValueChange={(v) => onChange({ ...value, type: v === ALL ? "" : (v as ScopeChoice["type"]) })}
        >
          <SelectTrigger className="h-8 w-[10.5rem] text-xs" aria-label="Staff or production" data-testid="scope-type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Staff + production</SelectItem>
            <SelectItem value="staff">Staff</SelectItem>
            <SelectItem value="production">Production</SelectItem>
          </SelectContent>
        </Select>
      )}
    </div>
  );
}
