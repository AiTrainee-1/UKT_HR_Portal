import type { FocusEvent } from "react";
import { ArrowRight, Check, Info, Moon, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  addRule,
  autoRuleLabel,
  confirmRow,
  isUnverifiedRow,
  ladderCap,
  setRuleTime,
  sortRules,
  unverifiedHint,
  type GroupErrors,
  type GroupRow,
  type RuleErrors,
  type RuleRow,
} from "./form";
import { absMinutes, pointText } from "./time";
import { Caption, ColumnHeading, leavesRow, Problem } from "./ui";

/** One ladder row: a flowing row on a phone, a table row from the wide layout on. */
const ROW =
  "flex flex-wrap items-end gap-x-3 gap-y-2 xl:grid xl:grid-cols-[3.25rem_13.5rem_15rem_minmax(8rem,1fr)_2.25rem] xl:items-center";

/** The id of a row's time box (the "Change the time" button of an unverified row goes there). */
const timeBoxId = (key: string) => `production-rule-${key}-time`;

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
 * One group's ladder, read as "Leaves at [time] -> earns [shifts]": a row for each leaving time, in time order, the rows
 * after midnight under their own heading (the time is the clock time with Next day ticked), the row at the shift's end
 * time marked. A row can be switched off, edited or removed, and rows are added at the end (HR sets the time). Rows are
 * put in time order when a box is left. A row that follows the owner's handwriting, which could be read two ways, says so
 * and can be confirmed as it is.
 */
export function LadderTable({
  group,
  name,
  patchGroup,
  readOnly,
  errors,
  rowErrors,
  endAt = null,
}: {
  group: GroupRow;
  /** The name rows are labelled with: "Day shift". */
  name: string;
  patchGroup: (key: string, change: Partial<GroupRow>) => void;
  readOnly: boolean;
  errors: GroupErrors;
  rowErrors: RuleErrors[];
  /** The group's end time (minutes from the shift day's midnight), to mark the row there; null without one. */
  endAt?: number | null;
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
  const hint = unverifiedHint(group.kind);

  return (
    <div className="space-y-2" data-testid="ladder">
      <p className="text-xs font-semibold text-slate-700">What leaving at each time earns</p>
      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed p-4 text-center text-xs text-gray-500" data-testid="ladder-empty">
          No rows: a day of this group earns nothing. Add a row to start.
        </p>
      ) : (
        <div className="rounded-lg border border-slate-200">
          <div className={cn(ROW, "hidden bg-slate-50 px-3 py-2")} aria-hidden>
            <ColumnHeading>In use</ColumnHeading>
            <ColumnHeading>Leaves at</ColumnHeading>
            <ColumnHeading>Earns</ColumnHeading>
            <ColumnHeading>Name</ColumnHeading>
            <span />
          </div>
          {rows.map((row, i) => {
            const e = rowErrors[i] ?? {};
            const n = i + 1;
            const unverified = isUnverifiedRow(group, row);
            const at = absMinutes(row.outTime, row.outNextDay);
            const atEnd = endAt !== null && at === endAt && row.enabled;
            const firstNextDay = row.outNextDay && (i === 0 || !rows[i - 1].outNextDay);
            return (
              <div key={row.key}>
                {firstNextDay && (
                  <p
                    className="flex items-center gap-1.5 border-t border-slate-200 bg-indigo-50/60 px-3 py-1.5 text-[11px] font-semibold text-indigo-900"
                    data-testid="ladder-next-day"
                  >
                    <Moon size={12} /> After midnight: the morning after the shift day began
                  </p>
                )}
                <div
                  data-row
                  data-testid="rule-row"
                  data-enabled={row.enabled ? "true" : "false"}
                  data-next-day={row.outNextDay ? "true" : "false"}
                  onBlur={sortAfter}
                  className={cn(
                    "border-t border-slate-100 px-3 py-3 xl:py-2",
                    i === 0 && !firstNextDay && "border-t-0",
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
                    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-xs font-semibold text-slate-500 xl:hidden">Leaves at</span>
                      <Input
                        id={timeBoxId(row.key)}
                        type="time"
                        aria-label={`${name}, row ${n}: leaves at`}
                        className={cn("h-8 w-[8.5rem]", (e.time || e.order || e.paid) && "border-red-400")}
                        value={row.outTime}
                        disabled={readOnly}
                        aria-invalid={e.time || e.order || e.paid ? true : undefined}
                        onChange={(ev) => setRows(setRuleTime(rows, row.key, { outTime: ev.target.value }))}
                      />
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
                    <div className="flex shrink-0 items-center gap-2">
                      <ArrowRight size={13} className="text-slate-400" aria-hidden />
                      <span className="text-xs font-semibold text-slate-500">earns</span>
                      <Input
                        type="text"
                        inputMode="decimal"
                        autoComplete="off"
                        aria-label={`${name}, row ${n}: shifts`}
                        className={cn("h-8 w-20 tabular-nums", e.value && "border-red-400")}
                        value={row.shiftValue}
                        disabled={readOnly}
                        aria-invalid={e.value ? true : undefined}
                        onChange={(ev) => change(row.key, { shiftValue: ev.target.value })}
                      />
                      <span className="text-xs text-slate-500">shifts</span>
                      {atEnd && (
                        <span
                          className="shrink-0 rounded-full bg-[#006496]/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[#006496]"
                          data-testid="rule-end-mark"
                          title="This row is at the shift's end time"
                        >
                          Shift end
                        </span>
                      )}
                    </div>
                    <div className="min-w-[9rem] flex-1 basis-40">
                      <Caption>Name</Caption>
                      <Input
                        type="text"
                        aria-label={`${name}, row ${n}: name`}
                        className="h-8"
                        value={row.label}
                        title={row.label || undefined}
                        disabled={readOnly}
                        placeholder={autoRuleLabel(row.outTime, row.outNextDay)}
                        aria-invalid={e.label ? true : undefined}
                        onChange={(ev) => change(row.key, { label: ev.target.value })}
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
                  {(e.label || e.time || e.order || e.paid || e.value || unverified) && (
                    <div className="mt-1.5 space-y-1">
                      {e.label && <Problem>{e.label}</Problem>}
                      {e.time && <Problem testId="rule-time-error">{e.time}</Problem>}
                      {e.order && <Problem testId="rule-order-error">{e.order}</Problem>}
                      {e.paid && <Problem testId="rule-paid-error">{e.paid}</Problem>}
                      {e.value && <Problem testId="rule-value-error">{e.value}</Problem>}
                      {unverified && (
                        <div
                          className="flex flex-wrap items-center gap-2 rounded-lg bg-amber-50 px-2.5 py-2 text-[12px] leading-snug text-amber-900 ring-1 ring-amber-200"
                          data-testid="unverified-row"
                        >
                          <Info size={13} className="shrink-0" />
                          <span className="min-w-0 flex-1 basis-56 font-semibold">
                            Check this row with the owner: {pointText(row.outTime, row.outNextDay)} as written, but{" "}
                            {hint || "the handwriting could be read another way"}.
                          </span>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-7 gap-1 bg-white px-2 text-xs"
                            disabled={readOnly}
                            data-testid="unverified-confirm"
                            onClick={() => setRows(confirmRow(rows, row.key))}
                          >
                            <Check size={12} /> Yes, it is right
                          </Button>
                          {!readOnly && (
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-7 px-2 text-xs text-amber-900"
                              onClick={() => document.getElementById(timeBoxId(row.key))?.focus()}
                            >
                              Change the time
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
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
