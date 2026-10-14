import type { FocusEvent } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { addAllowanceRow, autoAllowanceLabel, setAllowanceExtra, sortAllowanceRows, type AllowanceRow } from "./form";
import { leavesRow, Problem, type SectionProps } from "./ui";

/**
 * The Type 1 table: one row per amount of extra work after the shift end, with the minutes it earns for the next
 * morning's first punch. Every row can be renamed, switched off, or removed, and rows can be added.
 */
export function AllowanceTable({ draft, patch, readOnly, validation }: SectionProps) {
  const rows = draft.allowanceRules;
  const setRows = (next: AllowanceRow[]) => patch({ allowanceRules: next });
  const change = (key: string, part: Partial<AllowanceRow>) =>
    setRows(rows.map((r) => (r.key === key ? { ...r, ...part } : r)));
  const keepInOrder = (event: FocusEvent<HTMLElement>) => {
    if (leavesRow(event)) setRows(sortAllowanceRows(rows));
  };

  return (
    <div className="space-y-2" data-testid="allowance-rules">
      {rows.length === 0 ? (
        <p
          className="rounded-lg border border-dashed p-4 text-center text-xs text-gray-500"
          data-testid="allowance-empty"
        >
          No rules: no extra work earns an allowance. Add a rule to start.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm" data-testid="allowance-table">
            <thead>
              <tr className="bg-slate-50 text-left text-xs text-slate-600">
                <th className="px-3 py-2 font-semibold">In use</th>
                <th className="px-3 py-2 font-semibold">Name</th>
                <th className="px-3 py-2 font-semibold">Extra work after the shift end</th>
                <th className="px-3 py-2 font-semibold">Allowance for the next morning</th>
                <th className="px-3 py-2 text-right font-semibold">
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((row, i) => {
                const e = validation.allowanceRows[i] ?? {};
                const n = i + 1;
                return (
                  <tr key={row.key} data-testid="allowance-row" className={cn(!row.enabled && "bg-slate-50/60")}>
                    <td className="px-3 py-2 align-top">
                      <Switch
                        checked={row.enabled}
                        disabled={readOnly}
                        aria-label={`Rule ${n} in use`}
                        onCheckedChange={(v) => change(row.key, { enabled: v })}
                      />
                    </td>
                    <td className="px-3 py-2 align-top">
                      <Input
                        type="text"
                        aria-label={`Rule ${n}: name`}
                        className="h-8 min-w-[10rem]"
                        value={row.label}
                        disabled={readOnly}
                        placeholder={autoAllowanceLabel(row) || "Name"}
                        aria-invalid={e.label ? true : undefined}
                        onChange={(ev) => change(row.key, { label: ev.target.value })}
                      />
                      {e.label && <Problem>{e.label}</Problem>}
                    </td>
                    <td className="px-3 py-2 align-top">
                      <div className="flex items-center gap-1.5">
                        <Input
                          type="text"
                          inputMode="numeric"
                          aria-label={`Rule ${n}: hours of extra work`}
                          className={cn("h-8 w-16 tabular-nums", e.extra && "border-red-400")}
                          value={row.hours}
                          disabled={readOnly}
                          aria-invalid={e.extra ? true : undefined}
                          onChange={(ev) => setRows(setAllowanceExtra(rows, row.key, { hours: ev.target.value }))}
                          onBlur={keepInOrder}
                        />
                        <span className="text-xs font-semibold text-gray-500">h</span>
                        <Input
                          type="text"
                          inputMode="numeric"
                          aria-label={`Rule ${n}: minutes of extra work`}
                          className={cn("h-8 w-16 tabular-nums", e.extra && "border-red-400")}
                          value={row.minutes}
                          disabled={readOnly}
                          aria-invalid={e.extra ? true : undefined}
                          onChange={(ev) => setRows(setAllowanceExtra(rows, row.key, { minutes: ev.target.value }))}
                          onBlur={keepInOrder}
                        />
                        <span className="text-xs font-semibold text-gray-500">min</span>
                      </div>
                      {e.extra && <Problem>{e.extra}</Problem>}
                    </td>
                    <td className="px-3 py-2 align-top">
                      <div className="flex items-center gap-1.5">
                        <Input
                          type="text"
                          inputMode="numeric"
                          aria-label={`Rule ${n}: allowance minutes`}
                          className={cn("h-8 w-20 tabular-nums", e.allowance && "border-red-400")}
                          value={row.allowanceMinutes}
                          disabled={readOnly}
                          aria-invalid={e.allowance ? true : undefined}
                          onChange={(ev) => change(row.key, { allowanceMinutes: ev.target.value })}
                        />
                        <span className="text-xs font-semibold text-gray-500">minutes</span>
                      </div>
                      {e.allowance && <Problem>{e.allowance}</Problem>}
                    </td>
                    <td className="px-3 py-2 text-right align-top">
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        aria-label={`Remove rule ${n}`}
                        title="Remove this rule"
                        className="h-8 w-8 text-rose-600 hover:text-rose-800"
                        disabled={readOnly}
                        onClick={() => setRows(rows.filter((r) => r.key !== row.key))}
                      >
                        <Trash2 size={14} />
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {validation.allowanceTable && <Problem testId="allowance-table-error">{validation.allowanceTable}</Problem>}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="gap-1.5"
          disabled={readOnly}
          onClick={() => setRows(addAllowanceRow(rows))}
          data-testid="allowance-add"
        >
          <Plus size={13} /> Add a rule
        </Button>
        <span className="text-xs text-gray-500">Rows are kept in order of extra work when you leave a box.</span>
      </div>
    </div>
  );
}
