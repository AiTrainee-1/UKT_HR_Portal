import type { FocusEvent } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  addShiftRow,
  autoShiftLabel,
  setShiftLimit,
  SHIFT_CHOICES,
  sortShiftRows,
  suggestLimit,
  type ShiftRow,
} from "./form";
import { formatShort, formatUntil, parseUntil } from "./time";
import { leavesRow, Problem, type SectionProps } from "./ui";

/** Where each row starts: the limit of the row above that is on, or the start of Type 2 for the first one. */
function startsAt(rows: ShiftRow[], threshold: number | null): string[] {
  let previous: string | null = null;
  return rows.map((row) => {
    const from =
      previous ?? (threshold === null ? "the Type 2 start" : `${formatShort(threshold)} after the shift end`);
    if (row.enabled && !row.noLimit) {
      const parsed = parseUntil(row.until);
      if (parsed.error === undefined) previous = formatUntil(parsed.minutes);
    }
    return from;
  });
}

/**
 * The Type 2 table: the clock time of the day's last punch-out, and the shifts it earns. A row covers the last punch-outs
 * before its time (and from the row above); the last row can have no limit. Times are written as a clock time
 * ("9:00 PM", "12:00 AM", "2:00 AM next day") and understood on leaving the box.
 */
export function LadderTable({ draft, patch, readOnly, validation }: SectionProps) {
  const rows = draft.shiftRules;
  const setRows = (next: ShiftRow[]) => patch({ shiftRules: next });
  const change = (key: string, part: Partial<ShiftRow>) =>
    setRows(rows.map((r) => (r.key === key ? { ...r, ...part } : r)));
  const threshold =
    Number.isFinite(Number(draft.shiftMinExtra)) && draft.shiftMinExtra.trim() !== ""
      ? Number(draft.shiftMinExtra)
      : null;
  const starts = startsAt(rows, threshold);

  // Leaving the time box: say the time the way the system understood it ("21:00" becomes "9:00 PM"), then keep the rows in order.
  const understood = (key: string, event: FocusEvent<HTMLElement>) => {
    const row = rows.find((r) => r.key === key);
    if (!row || row.noLimit) return;
    const parsed = parseUntil(row.until);
    const text = parsed.error === undefined ? formatUntil(parsed.minutes) : row.until;
    const next = setShiftLimit(rows, key, { until: text });
    setRows(leavesRow(event) ? sortShiftRows(next) : next);
  };

  return (
    <div className="space-y-2" data-testid="shift-rules">
      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed p-4 text-center text-xs text-gray-500" data-testid="shift-empty">
          No rules: no day earns a shift. Add a rule to start.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm" data-testid="shift-table">
            <thead>
              <tr className="bg-slate-50 text-left text-xs text-slate-600">
                <th className="px-3 py-2 font-semibold">In use</th>
                <th className="px-3 py-2 font-semibold">Name</th>
                <th className="px-3 py-2 font-semibold">Last punch-out before</th>
                <th className="px-3 py-2 font-semibold">Shifts</th>
                <th className="px-3 py-2 text-right font-semibold">
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((row, i) => {
                const e = validation.shiftRows[i] ?? {};
                const n = i + 1;
                const known = SHIFT_CHOICES.some((c) => c.value === row.shifts);
                return (
                  <tr key={row.key} data-testid="shift-row" className={cn(!row.enabled && "bg-slate-50/60")}>
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
                        placeholder={autoShiftLabel(row.noLimit ? null : (parseUntil(row.until).minutes ?? null))}
                        aria-invalid={e.label ? true : undefined}
                        onChange={(ev) => change(row.key, { label: ev.target.value })}
                      />
                      {e.label && <Problem>{e.label}</Problem>}
                    </td>
                    <td className="px-3 py-2 align-top">
                      <Input
                        type="text"
                        autoComplete="off"
                        aria-label={`Rule ${n}: last punch-out before`}
                        className={cn("h-8 w-44", (e.until || e.order) && "border-red-400")}
                        value={row.noLimit ? "" : row.until}
                        placeholder={row.noLimit ? "no limit" : "9:00 PM"}
                        disabled={readOnly || row.noLimit}
                        aria-invalid={e.until || e.order ? true : undefined}
                        onChange={(ev) => setRows(setShiftLimit(rows, row.key, { until: ev.target.value }))}
                        onBlur={(event) => understood(row.key, event)}
                      />
                      <label className="mt-1.5 flex items-center gap-1.5 text-xs text-gray-600">
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5"
                          checked={row.noLimit}
                          disabled={readOnly}
                          aria-label={`Rule ${n}: no upper limit`}
                          onChange={(ev) => {
                            const noLimit = ev.target.checked;
                            const others = rows.filter((r) => r.key !== row.key);
                            const until =
                              !noLimit && row.until.trim() === ""
                                ? formatUntil(suggestLimit(others).minutes)
                                : row.until;
                            setRows(sortShiftRows(setShiftLimit(rows, row.key, { noLimit, until })));
                          }}
                        />
                        No upper limit (any later punch-out)
                      </label>
                      <p className="mt-1 text-[11px] text-gray-400">From: {starts[i]}</p>
                      {e.until && <Problem>{e.until}</Problem>}
                      {e.order && <Problem testId="shift-order-error">{e.order}</Problem>}
                    </td>
                    <td className="px-3 py-2 align-top">
                      <select
                        aria-label={`Rule ${n}: shifts`}
                        className={cn("h-8 rounded-md border bg-white px-2 text-sm", e.shifts && "border-red-400")}
                        value={row.shifts}
                        disabled={readOnly}
                        onChange={(ev) => change(row.key, { shifts: ev.target.value })}
                      >
                        {!known && <option value={row.shifts}>{row.shifts || "(choose)"}</option>}
                        {SHIFT_CHOICES.map((c) => (
                          <option key={c.value} value={c.value}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                      {e.shifts && <Problem>{e.shifts}</Problem>}
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
      {validation.shiftTable && <Problem testId="shift-table-error">{validation.shiftTable}</Problem>}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="gap-1.5"
          disabled={readOnly}
          onClick={() => setRows(addShiftRow(rows))}
          data-testid="shift-add"
        >
          <Plus size={13} /> Add a rule
        </Button>
        <span className="text-xs text-gray-500">
          Write a time such as 9:00 PM, or 2:00 AM next day for a time after midnight. 12:00 AM is midnight at the end
          of the day. A last punch-out exactly at a row's time belongs to the next row.
        </span>
      </div>
    </div>
  );
}
