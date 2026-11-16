import { Info, Moon, Plus, Sun, Trash2, Users, X } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { SettingBlock, SettingsSection } from "../kit/SettingBlock";
import { PRODUCTION_SHIFT_SECTIONS, productionShiftText } from "../ProductionShiftsTab.meta";
import { APPLIES_ON, KIND_LABEL, newGroup, unverifiedRows, type GroupRow } from "./form";
import { LadderTable } from "./LadderTable";
import { groupCardId, groupEndId } from "./SummarySection";
import { DAYS_WORDS, groupSummary } from "./summary";
import { absMinutes, atText, clock12, spanText, toMinutes } from "./time";
import { Problem, type SectionProps } from "./ui";

const block = (id: string) => ({ id, ...productionShiftText(id) });

const KIND_ICON: Record<GroupRow["kind"], ComponentType<{ size?: number; className?: string }>> = {
  day: Sun,
  night: Moon,
  sunday: Sun,
  custom: Users,
};

const APPLIES_WORDS: Record<GroupRow["appliesOn"], string> = {
  mon_sat: "Monday to Saturday",
  sunday: "Sunday",
  all: "any day",
};

/** A framed part of a group's card: "Shift time", "First punch". */
function Part({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <div className="min-w-0 space-y-2 rounded-lg border border-slate-200 bg-white p-3" data-testid={testId}>
      <p className="text-xs font-semibold text-slate-700">{title}</p>
      {children}
    </div>
  );
}

/** "From [08:30]" or "To [08:00 PM]": a word and a time box beside it (the pair wraps onto two lines on a phone). */
function TimeBox({
  word,
  ariaLabel,
  id,
  value,
  onChange,
  disabled,
  invalid,
}: {
  word: string;
  ariaLabel: string;
  id?: string;
  value: string;
  onChange: (next: string) => void;
  disabled: boolean;
  invalid: boolean;
}) {
  return (
    <span className="flex items-center gap-2">
      <span className="w-9 shrink-0 text-xs font-semibold text-slate-500">{word}</span>
      <Input
        id={id}
        type="time"
        aria-label={ariaLabel}
        value={value}
        disabled={disabled}
        aria-invalid={invalid ? true : undefined}
        className={cn("h-9 w-[8.75rem]", invalid && "border-red-400")}
        onChange={(ev) => onChange(ev.target.value)}
      />
    </span>
  );
}

/** The sentence under a group's From / To: the hours, or what is missing. */
function shiftTimeText(g: GroupRow, lastPoint: number | null, unpaid: number): string {
  const start = toMinutes(g.startTime);
  if (start === null) return "Enter the start time.";
  if (g.mainOutTime.trim() === "") {
    return `Starts at ${atText(start)}, with no end time: leaving early is never flagged.${
      lastPoint === null ? "" : ` Its last paid leaving time is ${atText(lastPoint)}.`
    }`;
  }
  const end = absMinutes(g.mainOutTime, g.mainOutNextDay);
  if (end === null || end <= start) return "The end must be after the start.";
  return `${atText(start)} to ${atText(end)}: ${spanText(end - start)}${
    unpaid > 0 ? `, of which ${spanText(unpaid)} is unpaid break` : ""
  }.`;
}

/**
 * The shift groups: one card for each (Day, Night, Sunday, and any HR adds). Each says its shift time as From [start] To
 * [end] (the end is the standard departure, which may be the next day), its first-punch window as From / To, the days it
 * is used on, and its ladder. A group HR adds starts switched off, because a group that is on must not share a first-punch
 * window with another that can be used on the same day.
 */
export function GroupsSection({ draft, patch, readOnly, validation }: SectionProps) {
  const setGroups = (groups: GroupRow[]) => patch({ groups });
  const patchGroup = (key: string, change: Partial<GroupRow>) =>
    setGroups(draft.groups.map((g) => (g.key === key ? { ...g, ...change } : g)));
  const unverified = unverifiedRows(draft);

  return (
    <SettingsSection
      id="production-shifts-groups"
      icon={Sun}
      title={PRODUCTION_SHIFT_SECTIONS.groups}
      purpose="The factory's shifts: the Day shift from 8:30 AM, the Night shift from 9:00 PM and the Sunday shift. Set each one's start and end, the window its first punch falls in, and what leaving at each time earns."
      usedBy={[
        { label: "Production Attendance", to: "/hr/attendance/production" },
        { label: "Production Payroll", to: "/hr/production-payroll" },
      ]}
      testId="production-shifts-groups"
    >
      <SettingBlock
        {...block("shift-groups")}
        className="lg:grid-cols-1"
        affects={[
          {
            where: "Production Attendance",
            what: "each day's group is the one whose first-punch window holds the first punch; its ladder gives the shifts earned",
            to: "/hr/attendance/production",
          },
          {
            where: "Production Payroll",
            what: "pay is the shifts earned times the salary per shift, the next time a period is generated",
            to: "/hr/production-payroll",
          },
        ]}
      >
        <div
          className="rounded-lg bg-slate-50 px-3 py-2.5 text-[12px] leading-snug text-slate-600 ring-1 ring-slate-200"
          data-testid="ladder-how-box"
        >
          <p className="mb-1 font-semibold text-slate-700">How a ladder works</p>
          <ul className="list-disc space-y-0.5 pl-4" data-testid="ladder-how">
            <li>Leaving exactly at a row's time earns that row's shifts.</li>
            <li>
              Between two rows the shifts grow by the paid minute: halfway through the paid time between 1.00 and 1.50
              is 1.25. Breaks are not counted.
            </li>
            <li>
              A first punch later than the start plus the grace loses shifts at the first row's rate; early costs
              nothing.
            </li>
            <li>
              A worker who punches in and out several times is paid for each pair, never for the gaps outside a break.
            </li>
          </ul>
        </div>
        {unverified.length > 0 && (
          <div
            className="flex items-start gap-2 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2.5 text-[12px] leading-snug text-sky-900"
            data-testid="unverified-banner"
          >
            <Info size={14} className="mt-0.5 shrink-0" />
            <div className="space-y-1">
              <p className="font-semibold">
                {unverified.length === 1 ? "Check this row with HR" : `Check these ${unverified.length} rows with HR`}
              </p>
              <p>
                They follow the owner's handwritten table exactly as it reads, but the handwriting could be read two
                ways. Ask the owner: if the row is right, press "Yes, it is right" on it (its name then says it was
                checked); if not, change its time or its shifts. Either way, save the rules afterwards.
              </p>
              <ul className="list-disc space-y-0.5 pl-4">
                {unverified.map(({ group, row, hint }) => (
                  <li key={row.key}>
                    {group}: leaving at {clock12(row.outTime)}
                    {row.outNextDay ? " the next morning" : ""} earns {Number(row.shiftValue).toFixed(2)} shifts ({hint}
                    )
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {validation.noGroup && <Problem testId="groups-none-on-error">{validation.noGroup}</Problem>}
        {draft.groups.length === 0 ? (
          <p
            className="rounded-lg border border-dashed p-4 text-center text-xs text-gray-500"
            data-testid="groups-empty"
          >
            No shift groups: with none in use every production day keeps the old calculation. Add a group to start.
          </p>
        ) : (
          <div className="space-y-4">
            {draft.groups.map((g, gi) => {
              const e = validation.groups[gi]?.errors ?? {};
              const name = g.label.trim() || `Group ${gi + 1}`;
              const KindIcon = KIND_ICON[g.kind];
              const s = groupSummary(g, draft.breaks, gi);
              const lastPoint = s.points.length > 0 ? s.points[s.points.length - 1].at : null;
              const setEnd = s.endSource === "set" ? s.end : null;
              return (
                <section
                  key={g.key}
                  id={groupCardId(g.key)}
                  data-testid="group-card"
                  data-kind={g.kind}
                  data-enabled={g.enabled ? "true" : "false"}
                  aria-label={name}
                  className={cn(
                    "scroll-mt-24 space-y-4 rounded-xl border border-slate-200 p-3 sm:p-4",
                    !g.enabled && "bg-slate-50",
                  )}
                >
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <span className="settings-tile h-8 w-8 shrink-0 rounded-lg">
                      <KindIcon size={15} />
                    </span>
                    <div className="min-w-[10rem] flex-1">
                      <Input
                        type="text"
                        aria-label={`${name}: name`}
                        value={g.label}
                        disabled={readOnly}
                        aria-invalid={e.label ? true : undefined}
                        className={cn("h-9 font-semibold", e.label && "border-red-400")}
                        onChange={(ev) => patchGroup(g.key, { label: ev.target.value })}
                      />
                    </div>
                    <span
                      className="settings-chip px-2 py-0.5 text-[11px] font-semibold text-slate-600"
                      data-testid="group-kind"
                    >
                      {KIND_LABEL[g.kind]}
                    </span>
                    <label className="flex items-center gap-2 text-xs font-semibold text-gray-700">
                      <Switch
                        checked={g.enabled}
                        disabled={readOnly}
                        aria-label={`${name}: in use`}
                        onCheckedChange={(v) => patchGroup(g.key, { enabled: v })}
                      />
                      {g.enabled ? "In use" : "Off"}
                    </label>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={`Remove group ${name}`}
                      title="Remove this group and its rows"
                      className="h-8 w-8 text-rose-600 hover:text-rose-800"
                      disabled={readOnly}
                      onClick={() => setGroups(draft.groups.filter((x) => x.key !== g.key))}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>
                  {e.label && <Problem>{e.label}</Problem>}
                  <p className="text-[13px] leading-snug text-slate-600" data-testid="group-headline">
                    <span className="font-semibold text-slate-800">{name}</span> · {DAYS_WORDS[g.appliesOn]}
                    {s.range ? ` · ${s.range}` : ""}
                    {g.enabled ? "" : " · switched off"}
                  </p>

                  <div className="grid gap-3 lg:grid-cols-2">
                    <Part title="Shift time" testId="group-shift-time">
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                        <TimeBox
                          word="From"
                          ariaLabel={`${name}: start time`}
                          value={g.startTime}
                          onChange={(v) => patchGroup(g.key, { startTime: v })}
                          disabled={readOnly}
                          invalid={!!e.start}
                        />
                        <TimeBox
                          word="To"
                          id={groupEndId(g.key)}
                          ariaLabel={`${name}: standard departure`}
                          value={g.mainOutTime}
                          onChange={(v) => patchGroup(g.key, { mainOutTime: v })}
                          disabled={readOnly}
                          invalid={!!e.mainOut}
                        />
                        <span className="flex items-center gap-2">
                          <label className="flex items-center gap-1.5 text-xs text-gray-600">
                            <input
                              type="checkbox"
                              className="h-3.5 w-3.5"
                              checked={g.mainOutNextDay}
                              disabled={readOnly || g.mainOutTime === ""}
                              aria-label={`${name}: standard departure is the next day`}
                              onChange={(ev) => patchGroup(g.key, { mainOutNextDay: ev.target.checked })}
                            />
                            Next day
                          </label>
                          {g.mainOutTime !== "" && (
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-7 gap-1 px-1.5 text-[11px] text-slate-500"
                              aria-label={`${name}: clear the end time`}
                              title="No end time: leaving early is then never flagged"
                              disabled={readOnly}
                              onClick={() => patchGroup(g.key, { mainOutTime: "", mainOutNextDay: false })}
                            >
                              <X size={12} /> Clear
                            </Button>
                          )}
                        </span>
                      </div>
                      <p
                        className={cn(
                          "text-[13px] font-medium leading-snug",
                          setEnd === null ? "text-amber-800" : "text-slate-800",
                        )}
                        data-testid="group-shift-time-text"
                      >
                        {shiftTimeText(g, lastPoint, s.unpaid)}
                      </p>
                      <p className="text-[11px] leading-snug text-gray-500">
                        The grace comes after the start. The end is the standard departure: leaving before it (less the
                        grace) is flagged Left early. For an end after midnight tick Next day. Neither time changes the
                        shifts earned: the ladder below does.
                      </p>
                    </Part>

                    <Part title="First punch window" testId="group-window">
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                        <TimeBox
                          word="From"
                          ariaLabel={`${name}: first punch from`}
                          value={g.firstPunchFrom}
                          onChange={(v) => patchGroup(g.key, { firstPunchFrom: v })}
                          disabled={readOnly}
                          invalid={!!(e.window || e.overlap)}
                        />
                        <TimeBox
                          word="To"
                          ariaLabel={`${name}: first punch to`}
                          value={g.firstPunchTo}
                          onChange={(v) => patchGroup(g.key, { firstPunchTo: v })}
                          disabled={readOnly}
                          invalid={!!(e.window || e.overlap)}
                        />
                      </div>
                      {!e.window && !e.overlap && (
                        <p className="text-[13px] leading-snug text-slate-800" data-testid="group-window-note">
                          A day whose first punch is between {clock12(g.firstPunchFrom)} and {clock12(g.firstPunchTo)}{" "}
                          on {APPLIES_WORDS[g.appliesOn]} uses this group{g.enabled ? "" : " (once it is switched on)"}.
                        </p>
                      )}
                      <p className="text-[11px] leading-snug text-gray-500">
                        Only the first punch of the day decides the group; the window may start hours before the shift.
                      </p>
                      <label className="flex flex-wrap items-center gap-2 pt-1 text-xs font-semibold text-slate-700">
                        Used on
                        <select
                          aria-label={`${name}: used on`}
                          className="h-9 min-w-[11rem] rounded-md border bg-white px-2 text-sm font-normal disabled:opacity-50"
                          value={g.appliesOn}
                          disabled={readOnly}
                          onChange={(ev) => patchGroup(g.key, { appliesOn: ev.target.value as GroupRow["appliesOn"] })}
                        >
                          {APPLIES_ON.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    </Part>
                  </div>
                  {(e.start || e.window || e.mainOut || e.overlap) && (
                    <div className="space-y-1">
                      {e.start && <Problem testId="group-start-error">{e.start}</Problem>}
                      {e.window && <Problem testId="group-window-error">{e.window}</Problem>}
                      {e.mainOut && <Problem>{e.mainOut}</Problem>}
                      {e.overlap && <Problem testId="group-overlap-error">{e.overlap}</Problem>}
                    </div>
                  )}
                  {!g.enabled && g.rules.length > 0 && (
                    <p className="text-[11px] leading-snug text-slate-500" data-testid="group-off-note">
                      This group is switched off, so its ladder is not checked for order yet: that happens when it is
                      switched on.
                    </p>
                  )}

                  <LadderTable
                    group={g}
                    name={name}
                    patchGroup={patchGroup}
                    readOnly={readOnly}
                    errors={e}
                    rowErrors={validation.groups[gi]?.rules ?? []}
                    endAt={setEnd}
                  />
                </section>
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
            onClick={() => setGroups([...draft.groups, newGroup()])}
            data-testid="group-add"
          >
            <Plus size={13} /> Add a group
          </Button>
          <span className="text-xs text-gray-500">
            A new group starts switched off: set its times and ladder, then switch it on.
          </span>
        </div>
      </SettingBlock>
    </SettingsSection>
  );
}
