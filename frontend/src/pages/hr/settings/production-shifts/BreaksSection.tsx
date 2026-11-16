import type { FocusEvent } from "react";
import { Coffee, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { SettingBlock, SettingsSection } from "../kit/SettingBlock";
import { PRODUCTION_SHIFT_SECTIONS, productionShiftText } from "../ProductionShiftsTab.meta";
import { addBreak, autoBreakLabel, breakSpans, setBreakStart, sortBreaks, type BreakRow } from "./form";
import { ShiftTimeline } from "./ShiftTimeline";
import { breakTotals } from "./summary";
import { spanText, toMinutes } from "./time";
import { Caption, ColumnHeading, leavesRow, Problem, type SectionProps } from "./ui";

const block = (id: string) => ({ id, ...productionShiftText(id) });

const ROW =
  "flex flex-wrap items-end gap-x-3 gap-y-2 xl:grid xl:grid-cols-[3.25rem_23.5rem_9rem_minmax(8rem,1fr)_2.25rem] xl:items-center";

/** How long a break is ("45 min", "1 h"); blank while its times cannot be read or it ends before it starts. */
export function breakLength(row: Pick<BreakRow, "startTime" | "endTime">): string {
  const start = toMinutes(row.startTime);
  const end = toMinutes(row.endTime);
  if (start === null || end === null || end <= start) return "";
  return spanText(end - start);
}

/**
 * The breaks (tea, lunch, dinner): unpaid time inside the day, the same for every group. Each is a row "From [10:30 AM]
 * To [10:45 AM] · 15 min, not paid", with the total unpaid time of a day and a bar of the whole day above them. They are
 * the table behind "nobody punches for a break", and a ladder is worked out without them.
 */
export function BreaksSection({ draft, patch, readOnly, validation }: SectionProps) {
  const rows = draft.breaks;
  const setRows = (next: BreakRow[]) => patch({ breaks: next });
  const change = (key: string, part: Partial<BreakRow>) =>
    setRows(rows.map((r) => (r.key === key ? { ...r, ...part } : r)));
  // a break takes its place in the time order when focus leaves the row (not while moving between its own boxes)
  const sortAfter = (event: FocusEvent<HTMLElement>) => {
    if (leavesRow(event)) setRows(sortBreaks(rows));
  };
  const totals = breakTotals(rows);

  return (
    <SettingsSection
      id="production-shifts-breaks"
      icon={Coffee}
      title={PRODUCTION_SHIFT_SECTIONS.breaks}
      purpose="The tea breaks, the lunch break and the night dinner break. Time in them is never paid and nobody needs to punch for them."
      usedBy={[
        { label: "Production Attendance", to: "/hr/attendance/production" },
        { label: "Production Payroll", to: "/hr/production-payroll" },
      ]}
      testId="production-shifts-breaks"
    >
      <SettingBlock
        {...block("breaks")}
        className="lg:grid-cols-1"
        affects={[
          {
            where: "Production Attendance",
            what: "the minutes of a break are left out when the shifts between two punches are worked out",
            to: "/hr/attendance/production",
          },
        ]}
        note="A break is the same for every group and every day. A break may not overlap another that is on, and a ladder row should not fall inside one: a break is flat, so a row inside it earns what leaving when the break starts earns."
      >
        <div className="space-y-3" data-testid="breaks">
          <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-3">
            <p className="text-[13px] font-semibold text-slate-800" data-testid="breaks-total">
              {totals.text}
            </p>
            <ShiftTimeline start={null} spans={breakSpans(rows)} summary={totals.text} testId="breaks-timeline" />
          </div>

          {rows.length === 0 ? (
            <p
              className="rounded-lg border border-dashed p-4 text-center text-xs text-gray-500"
              data-testid="breaks-empty"
            >
              No breaks: every minute between a worker's punches is paid. Add a break if there is one.
            </p>
          ) : (
            <div className="rounded-lg border border-slate-200">
              <div className={cn(ROW, "hidden bg-slate-50 px-3 py-2")} aria-hidden>
                <ColumnHeading>In use</ColumnHeading>
                <ColumnHeading>Time</ColumnHeading>
                <ColumnHeading>Length</ColumnHeading>
                <ColumnHeading>Name</ColumnHeading>
                <span />
              </div>
              {rows.map((row, i) => {
                const e = validation.breaks[i] ?? {};
                const n = i + 1;
                const length = breakLength(row);
                return (
                  <div
                    key={row.key}
                    data-row
                    data-testid="break-row"
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
                          aria-label={`Break ${n}: in use`}
                          onCheckedChange={(v) => change(row.key, { enabled: v })}
                        />
                      </div>
                      <div className="flex min-w-0 max-w-full flex-wrap items-center gap-x-3 gap-y-2">
                        <span className="flex items-center gap-2">
                          <span className="w-9 text-xs font-semibold text-slate-500">From</span>
                          <Input
                            type="time"
                            aria-label={`Break ${n}: from`}
                            className={cn("h-8 w-[8.5rem]", (e.start || e.overlap) && "border-red-400")}
                            value={row.startTime}
                            disabled={readOnly}
                            aria-invalid={e.start || e.overlap ? true : undefined}
                            onChange={(ev) => setRows(setBreakStart(rows, row.key, ev.target.value))}
                          />
                        </span>
                        <span className="flex items-center gap-2">
                          <span className="w-9 text-xs font-semibold text-slate-500">To</span>
                          <Input
                            type="time"
                            aria-label={`Break ${n}: to`}
                            className={cn("h-8 w-[8.5rem]", (e.end || e.overlap) && "border-red-400")}
                            value={row.endTime}
                            disabled={readOnly}
                            aria-invalid={e.end || e.overlap ? true : undefined}
                            onChange={(ev) => change(row.key, { endTime: ev.target.value })}
                          />
                        </span>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5 text-xs">
                        <span className="font-semibold tabular-nums text-gray-700" data-testid="break-length">
                          {length || "-"}
                        </span>
                        <span
                          className={cn(
                            "rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
                            row.enabled
                              ? "bg-slate-100 text-slate-600"
                              : "bg-white text-slate-400 ring-1 ring-slate-200",
                          )}
                          data-testid="break-paid"
                        >
                          {row.enabled ? "not paid" : "off: paid"}
                        </span>
                      </div>
                      <div className="min-w-[9rem] flex-1 basis-40">
                        <Caption>Name</Caption>
                        <Input
                          type="text"
                          aria-label={`Break ${n}: name`}
                          className="h-8"
                          value={row.label}
                          disabled={readOnly}
                          placeholder={autoBreakLabel(row.startTime)}
                          aria-invalid={e.label ? true : undefined}
                          onChange={(ev) => change(row.key, { label: ev.target.value })}
                        />
                      </div>
                      <div className="ml-auto shrink-0 xl:ml-0">
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          aria-label={`Remove break ${n}`}
                          title="Remove this break"
                          className="h-8 w-8 text-rose-600 hover:text-rose-800"
                          disabled={readOnly}
                          onClick={() => setRows(rows.filter((r) => r.key !== row.key))}
                        >
                          <Trash2 size={14} />
                        </Button>
                      </div>
                    </div>
                    {(e.label || e.start || e.end || e.overlap) && (
                      <div className="mt-1.5 space-y-1">
                        {e.label && <Problem>{e.label}</Problem>}
                        {e.start && <Problem testId="break-start-error">{e.start}</Problem>}
                        {e.end && <Problem testId="break-end-error">{e.end}</Problem>}
                        {e.overlap && <Problem testId="break-overlap-error">{e.overlap}</Problem>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="gap-1.5"
              disabled={readOnly}
              onClick={() => setRows(addBreak(rows))}
              data-testid="break-add"
            >
              <Plus size={13} /> Add a break
            </Button>
            <span className="text-xs text-gray-500">
              A break is inside one day: it ends after it starts and before midnight. Breaks stay in time order. A break
              that is switched off is paid like any other time.
            </span>
          </div>
        </div>
      </SettingBlock>
    </SettingsSection>
  );
}
