import type { FocusEvent } from "react";
import { Coffee, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { SettingBlock, SettingsSection } from "../kit/SettingBlock";
import { PRODUCTION_SHIFT_SECTIONS, productionShiftText } from "../ProductionShiftsTab.meta";
import { addBreak, autoBreakLabel, setBreakStart, sortBreaks, type BreakRow } from "./form";
import { toMinutes } from "./time";
import { Caption, ColumnHeading, leavesRow, Problem, type SectionProps } from "./ui";

const block = (id: string) => ({ id, ...productionShiftText(id) });

const ROW =
  "flex flex-wrap items-end gap-x-3 gap-y-2 xl:grid xl:grid-cols-[3.25rem_minmax(8rem,1fr)_8rem_8rem_5.5rem_2.25rem] xl:items-center";

/** How long a break is, for the column beside its times ("45 min", "1 h"); blank while its times cannot be read. */
function length(row: BreakRow): string {
  const start = toMinutes(row.startTime);
  const end = toMinutes(row.endTime);
  if (start === null || end === null || end <= start) return "";
  const minutes = end - start;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h === 0 ? `${m} min` : m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/**
 * The breaks (tea, lunch, dinner): unpaid time inside the day, the same for every group. They are the table behind
 * "nobody punches for a break", and a ladder is worked out without them.
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
        <div className="space-y-2" data-testid="breaks">
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
                <ColumnHeading>Name</ColumnHeading>
                <ColumnHeading>From</ColumnHeading>
                <ColumnHeading>To</ColumnHeading>
                <ColumnHeading>Length</ColumnHeading>
                <span />
              </div>
              {rows.map((row, i) => {
                const e = validation.breaks[i] ?? {};
                const n = i + 1;
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
                      <div className="w-32 shrink-0 xl:w-auto">
                        <Caption>From</Caption>
                        <Input
                          type="time"
                          aria-label={`Break ${n}: from`}
                          className={cn("h-8", (e.start || e.overlap) && "border-red-400")}
                          value={row.startTime}
                          disabled={readOnly}
                          aria-invalid={e.start || e.overlap ? true : undefined}
                          onChange={(ev) => setRows(setBreakStart(rows, row.key, ev.target.value))}
                        />
                      </div>
                      <div className="w-32 shrink-0 xl:w-auto">
                        <Caption>To</Caption>
                        <Input
                          type="time"
                          aria-label={`Break ${n}: to`}
                          className={cn("h-8", (e.end || e.overlap) && "border-red-400")}
                          value={row.endTime}
                          disabled={readOnly}
                          aria-invalid={e.end || e.overlap ? true : undefined}
                          onChange={(ev) => change(row.key, { endTime: ev.target.value })}
                        />
                      </div>
                      <div className="shrink-0 text-xs font-semibold text-gray-600" data-testid="break-length">
                        <Caption>Length</Caption>
                        <span className="flex h-8 items-center">{length(row) || "-"}</span>
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
              A break is inside one day: it ends after it starts and before midnight. Breaks stay in time order.
            </span>
          </div>
        </div>
      </SettingBlock>
    </SettingsSection>
  );
}
