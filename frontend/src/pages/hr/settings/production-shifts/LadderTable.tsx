import type { FocusEvent } from "react";
import { Info, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  addRule,
  autoRuleLabel,
  isUnverifiedRow,
  ladderCap,
  setRuleTime,
  sortRules,
  type GroupErrors,
  type GroupRow,
  type RuleErrors,
  type RuleRow,
} from "./form";
import { pointText } from "./time";
import { Caption, ColumnHeading, leavesRow, Problem } from "./ui";

/** One ladder row: a flowing row on a phone, a table row from the wide layout on. */
const ROW =
  "flex flex-wrap items-end gap-x-3 gap-y-2 xl:grid xl:grid-cols-[3.25rem_minmax(8rem,1fr)_8rem_6.5rem_6rem_2.25rem] xl:items-center";

/** What leaving after the last row means, in a sentence (the Sunday one says that no rule was given for it). */
function capText(group: GroupRow): string | null {
  const cap = ladderCap(group);
  if (!cap) return null;
  const shifts = `${Number(cap.value).toFixed(2)} shift${Number(cap.value) === 1 ? "" : "s"}`;
  const at = pointText(cap.time, cap.nextDay);
  if (group.kind === "sunday") {
    return `Nothing was given for Sunday work after ${at}, so leaving later than that earns no more than ${shifts}. Add a row if later Sunday work should earn more.`;
  }
  return `Leaving later than ${at} earns no more than ${shifts}.`;
}

/**
 * One group's ladder: a row for each leaving time and the shifts earned by leaving then. A row can be switched off, edited
 * or removed, and rows are added at the end (HR sets the time). Rows are put in time order when a box is left, because a
 * ladder only makes sense in time order. A time after midnight is the clock time with "Next day" ticked.
 */
export function LadderTable({
  group,
  name,
  patchGroup,
  readOnly,
  errors,
  rowErrors,
}: {
  group: GroupRow;
  /** The name rows are labelled with: "Day shift". */
  name: string;
  patchGroup: (key: string, change: Partial<GroupRow>) => void;
  readOnly: boolean;
  errors: GroupErrors;
  rowErrors: RuleErrors[];
}) {
  const rows = group.rules;
  const setRows = (next: RuleRow[]) => patchGroup(group.key, { rules: next });
  const change = (key: string, part: Partial<RuleRow>) =>
    setRows(rows.map((r) => (r.key === key ? { ...r, ...part } : r)));
  // a row takes its place in the time order when focus leaves the row (not while moving between its own boxes)
  const sortAfter = (event: FocusEvent<HTMLElement>) => {
    if (leavesRow(event)) setRows(sortRules(rows));
  };
  const cap = capText(group);

  return (
    <div className="space-y-2" data-testid="ladder">
      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed p-4 text-center text-xs text-gray-500" data-testid="ladder-empty">
          No rows: a day of this group earns nothing. Add a row to start.
        </p>
      ) : (
        <div className="rounded-lg border border-slate-200">
          <div className={cn(ROW, "hidden bg-slate-50 px-3 py-2")} aria-hidden>
            <ColumnHeading>In use</ColumnHeading>
            <ColumnHeading>Name</ColumnHeading>
            <ColumnHeading>Leaves at</ColumnHeading>
            <ColumnHeading>Next morning</ColumnHeading>
            <ColumnHeading>Shifts</ColumnHeading>
            <span />
          </div>
          {rows.map((row, i) => {
            const e = rowErrors[i] ?? {};
            const n = i + 1;
            return (
              <div
                key={row.key}
                data-row
                data-testid="rule-row"
                data-enabled={row.enabled ? "true" : "false"}
                onBlur={sortAfter}
                className={cn(
                  "border-t border-slate-100 px-3 py-3 first:border-t-0 xl:py-2",
                  !row.enabled && "bg-slate-50",
                )}
              >
                <div className={ROW}>
                  <div className="shrink-0">
                    <Caption>In use</Caption>
                    <Switch
                      checked={row.enabled}
                      disabled={readOnly}
                      aria-label={`${name}, row ${n}: in use`}
                      onCheckedChange={(v) => change(row.key, { enabled: v })}
                    />
                  </div>
                  <div className="min-w-[9rem] flex-1 basis-40">
                    <Caption>Name</Caption>
                    <Input
                      type="text"
                      aria-label={`${name}, row ${n}: name`}
                      className="h-8"
                      value={row.label}
                      disabled={readOnly}
                      placeholder={autoRuleLabel(row.outTime, row.outNextDay)}
                      aria-invalid={e.label ? true : undefined}
                      onChange={(ev) => change(row.key, { label: ev.target.value })}
                    />
                  </div>
                  <div className="w-32 shrink-0 xl:w-auto">
                    <Caption>Leaves at</Caption>
                    <Input
                      type="time"
                      aria-label={`${name}, row ${n}: leaves at`}
                      className={cn("h-8", (e.time || e.order || e.paid) && "border-red-400")}
                      value={row.outTime}
                      disabled={readOnly}
                      aria-invalid={e.time || e.order || e.paid ? true : undefined}
                      onChange={(ev) => setRows(setRuleTime(rows, row.key, { outTime: ev.target.value }))}
                    />
                  </div>
                  <div className="shrink-0">
                    <Caption>Next morning</Caption>
                    <label className="flex h-8 items-center gap-1.5 text-xs text-gray-600">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5"
                        checked={row.outNextDay}
                        disabled={readOnly}
                        aria-label={`${name}, row ${n}: next day`}
                        onChange={(ev) => setRows(setRuleTime(rows, row.key, { outNextDay: ev.target.checked }))}
                      />
                      Next day
                    </label>
                  </div>
                  <div className="w-24 shrink-0 xl:w-auto">
                    <Caption>Shifts</Caption>
                    <Input
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      aria-label={`${name}, row ${n}: shifts`}
                      className={cn("h-8 tabular-nums", e.value && "border-red-400")}
                      value={row.shiftValue}
                      disabled={readOnly}
                      aria-invalid={e.value ? true : undefined}
                      onChange={(ev) => change(row.key, { shiftValue: ev.target.value })}
                    />
                  </div>
                  <div className="ml-auto shrink-0 xl:ml-0">
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={`Remove ${name} row ${n}`}
                      title="Remove this row"
                      className="h-8 w-8 text-rose-600 hover:text-rose-800"
                      disabled={readOnly}
                      onClick={() => setRows(rows.filter((r) => r.key !== row.key))}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>
                </div>
                {(e.label || e.time || e.order || e.paid || e.value || isUnverifiedRow(group, row)) && (
                  <div className="mt-1.5 space-y-1">
                    {e.label && <Problem>{e.label}</Problem>}
                    {e.time && <Problem testId="rule-time-error">{e.time}</Problem>}
                    {e.order && <Problem testId="rule-order-error">{e.order}</Problem>}
                    {e.paid && <Problem testId="rule-paid-error">{e.paid}</Problem>}
                    {e.value && <Problem testId="rule-value-error">{e.value}</Problem>}
                    {isUnverifiedRow(group, row) && (
                      <p
                        className="flex items-start gap-1.5 text-[11px] font-semibold text-amber-800"
                        data-testid="unverified-row"
                      >
                        <Info size={12} className="mt-px shrink-0" />
                        Check this row with HR: the owner's handwriting could be read two ways (see the note above).
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {errors.table && <Problem testId="ladder-table-error">{errors.table}</Problem>}
      {cap && (
        <p
          className="flex items-start gap-1.5 text-xs leading-snug text-gray-600"
          data-testid={group.kind === "sunday" ? "sunday-note" : "ladder-cap"}
        >
          <Info size={13} className="mt-0.5 shrink-0 text-slate-400" />
          <span>{cap}</span>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="gap-1.5"
          disabled={readOnly}
          onClick={() => setRows(addRule(group))}
          data-testid="rule-add"
        >
          <Plus size={13} /> Add a row
        </Button>
        <span className="text-xs text-gray-500">
          Rows stay in time order. For a time after midnight enter the clock time and tick Next day: 5:30 in the morning
          after is 05:30 with Next day ticked.
        </span>
      </div>
    </div>
  );
}
