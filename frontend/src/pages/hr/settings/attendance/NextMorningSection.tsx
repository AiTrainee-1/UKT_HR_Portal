import { Sunrise } from "lucide-react";
import { Input } from "@/components/ui/input";
import { clock, minutesOf } from "@/lib/arrival-rules";
import { cn } from "@/lib/utils";
import { ToggleField } from "../kit/Field";
import { RuleHistory, type RuleHistoryLine } from "../kit/RuleHistory";
import { PreviewCard, PreviewLine, SettingBlock, SettingsSection } from "../kit/SettingBlock";
import { ATTENDANCE_SECTIONS, attendanceText } from "../AttendanceTab.meta";
import { dayText, type StaffDraft, type StaffErrors } from "./form";
import { UnitInput } from "./UnitInput";

const block = (id: string) => ({ id, ...attendanceText(id) });

const AFFECTS = [
  {
    where: "Staff Attendance",
    what: "a punch before the cut-off ends the day before (its last punch, so its Early Out and Full Day / Half Day can change); from the cut-off on it is the new day's arrival",
    to: "/hr/attendance/staff",
  },
  {
    where: "Compensation - OT Detection",
    what: "the overtime of the day before is measured from its shift end to that punch, shown as '02:10 next day'",
    to: "/hr/compensation/ot-detection/type-2/waiting",
  },
  { where: "Staff Payroll", what: "pays the days as they are then judged", to: "/hr/payroll" },
];

/** The worked example's fixed day: a 08:30-17:30 shift; in 08:30, out 13:00, in 14:00 and no exit punch (left open). */
const EXAMPLE = { start: 8 * 60 + 30, end: 17 * 60 + 30, punches: ["08:30", "13:00", "14:00"] };
const NIGHT_PUNCH = 2 * 60 + 10; // 02:10 the next morning
const MORNING_PUNCH = 6 * 60 + 20; // 06:20 the next morning

/** The next-morning rule's dated history in words, oldest first. */
export function nextMorningHistoryLines(
  history: { from: string | null; enabled: boolean; cutoff: string }[],
): RuleHistoryLine[] {
  return history.map((entry) => ({
    when: entry.from ? `From ${dayText(entry.from)}` : "From the start",
    what: entry.enabled ? `on, cut-off ${entry.cutoff}` : "off (the forgotten last-out window decides)",
  }));
}

/**
 * The cut-off that really applies to the example's Tuesday: the setting, moved earlier by the early-arrival guard (the
 * 08:30 shift start minus the early-arrival protection hours), never below 00:00 - exactly what the server does
 * (shift_engine.staff_next_morning_day_cutoff_secs).
 */
export function guardedCutoff(cutoff: number, shiftStart: number, protectionHours: number): number {
  const guard = shiftStart - Math.round(protectionHours * 60);
  return Math.max(0, Math.min(cutoff, guard));
}

/** "8 h 40 min". */
const span = (minutes: number): string => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
};

/**
 * The staff next-morning cut-off (owner 2026-11-19, like production's 06:00): a staff punch on the next morning BEFORE the
 * cut-off belongs to the day before as its overtime when that day's punches leave a session open (an odd number of
 * punches); from the cut-off on it is the new day's arrival. Per employee, from the date below (it only moves later); days
 * before it, and the whole rule while it is off, keep the forgotten last-out window of the section below.
 */
export function NextMorningSection({
  draft,
  patch,
  errors,
  loaded,
  reported,
  savedFrom,
  today,
  companyWide = true,
  history = [],
}: {
  draft: StaffDraft;
  patch: (p: Partial<StaffDraft>) => void;
  errors: StaffErrors;
  loaded: boolean;
  /** False for an older server that does not report the rule: shown, but it cannot be changed. */
  reported: boolean;
  /** The saved start date ("" = not set): the box cannot go earlier. */
  savedFrom: string;
  today: string;
  /** False for a branch login: a company-wide rule, shown but only an administrator can change it. */
  companyWide?: boolean;
  /** When the rule was switched on / off and which cut-off applied (read-only, oldest first; empty = never changed). */
  history?: { from: string | null; enabled: boolean; cutoff: string }[];
}) {
  const on = draft.nextMorningEnabled === true;
  const parsed = minutesOf(draft.nextMorningCutoff);
  const valid = parsed !== null && !errors.nextMorningCutoff;
  const cutoff = parsed ?? 0;
  const locked = !loaded || !reported || !companyWide;
  // the early-arrival guard: Tuesday's own 08:30 shift start minus the protection hours (Forgotten last-out section)
  const protection = Number(draft.earlyArrivalProtectionHours);
  const protectionHours = Number.isFinite(protection) && protection >= 0 ? protection : 0;
  const effective = guardedCutoff(cutoff, EXAMPLE.start, protectionHours);
  const guarded = effective < cutoff;
  const nightIsOt = on && valid && NIGHT_PUNCH < effective;
  const morningIsArrival = on && valid && MORNING_PUNCH >= effective;
  // both early punches before the cut-off end Monday (as the server judges it): its overtime runs to the later one
  const otEnd = morningIsArrival ? NIGHT_PUNCH : MORNING_PUNCH;
  // forward-only: never earlier than the saved date, nor than today (the server refuses a changed date before today)
  const minDate = savedFrom && savedFrom > today ? savedFrom : today;

  const preview = (
    <PreviewCard
      title="Worked example"
      scenario={`Monday's shift is ${clock(EXAMPLE.start)}-${clock(EXAMPLE.end)}. Monday: in ${EXAMPLE.punches[0]}, out ${EXAMPLE.punches[1]}, in ${EXAMPLE.punches[2]}, and no exit punch, so Monday is left open. Then Tuesday's machine records ${clock(NIGHT_PUNCH)} and ${clock(MORNING_PUNCH)}.`}
      testId="next-morning-example"
    >
      {!on ? (
        <PreviewLine
          testId="next-morning-off-line"
          label="Switched off"
          result="The forgotten last-out window below decides which day a night punch belongs to"
          tone="neutral"
        />
      ) : !valid ? (
        <p className="text-[12px] text-gray-500">Enter a valid cut-off to see it.</p>
      ) : (
        <>
          {guarded && (
            <PreviewLine
              testId="next-morning-guard-line"
              label="Early-arrival guard"
              result={`Tuesday's cut-off is ${clock(effective)}, not ${clock(cutoff)}: its ${clock(EXAMPLE.start)} shift start minus ${protectionHours} h of early-arrival protection, so an arrival from ${clock(effective)} is Tuesday's own`}
              tone="info"
            />
          )}
          <PreviewLine
            testId="next-morning-night-line"
            label={`Punch at ${clock(NIGHT_PUNCH)} next morning`}
            result={
              nightIsOt
                ? `Monday's overtime: from the ${clock(EXAMPLE.end)} shift end until ${clock(otEnd)}${
                    otEnd === NIGHT_PUNCH ? "" : ", its last early punch"
                  } (${span(24 * 60 - EXAMPLE.end + otEnd)})`
                : `Tuesday's arrival: it is not before the ${clock(effective)} cut-off`
            }
            tone={nightIsOt ? "good" : "warn"}
          />
          <PreviewLine
            testId="next-morning-morning-line"
            label={`Punch at ${clock(MORNING_PUNCH)}`}
            result={
              morningIsArrival
                ? `Tuesday's arrival: from ${clock(effective)} a punch starts the new day`
                : `Monday's last punch: it is before the ${clock(effective)} cut-off`
            }
            tone={morningIsArrival ? "info" : "warn"}
          />
          <PreviewLine
            testId="next-morning-closed-line"
            label={`Had Monday an exit punch (out 18:05)`}
            result={`Monday is complete, so ${clock(NIGHT_PUNCH)} is Tuesday's first punch`}
            tone="neutral"
          />
        </>
      )}
    </PreviewCard>
  );

  return (
    <SettingsSection
      id="attendance-next-morning"
      icon={Sunrise}
      title={ATTENDANCE_SECTIONS.nextMorning}
      purpose="Staff who work through the night punch out the next morning. Like the production 06:00 rule, a punch before the cut-off ends the night before as its overtime; from the cut-off on it starts the new day. Each employee's own punches decide. Staff only."
      usedBy={[
        { label: "Staff Attendance", to: "/hr/attendance/staff" },
        { label: "Compensation", to: "/hr/compensation/ot-detection/type-2/waiting" },
      ]}
      testId="attendance-next-morning"
    >
      <SettingBlock
        {...block("staff-next-morning")}
        labelFor="staff-next-morning-switch"
        defaultText="On, 06:00"
        affects={AFFECTS}
        note={
          !reported
            ? "This server does not report the next-morning cut-off yet, so it cannot be changed here."
            : `Only when the day before is left open (an odd number of punches); a complete day keeps the punch as the new day's first. The overtime is measured from that day's shift end to the punch. A punch inside the employee's own early-arrival window (their shift start minus the early-arrival protection hours) is always the new day's arrival: a 06:00 shift with 2 hours' protection moves the cut-off to 04:00, an 08:30 shift keeps 06:00.${
                companyWide ? "" : " A company-wide rule: only an administrator can change it."
              }`
        }
        preview={preview}
      >
        <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
          <ToggleField
            id="staff-next-morning-switch"
            checked={on}
            onChange={(v) => patch({ nextMorningEnabled: v })}
            onLabel="Next-morning punches before the cut-off end the night before"
            offLabel="The forgotten last-out window decides"
            disabled={locked}
          >
            Like production&apos;s 06:00 rule, for staff.
          </ToggleField>
          <div className="space-y-1.5">
            <label htmlFor="staff-next-morning-cutoff" className="text-xs font-semibold text-gray-700">
              Cut-off
            </label>
            <UnitInput
              id="staff-next-morning-cutoff"
              type="time"
              value={draft.nextMorningCutoff}
              onChange={(v) => patch({ nextMorningCutoff: v })}
              unit="next morning"
              disabled={locked || !on}
              error={errors.nextMorningCutoff}
              errorTestId="next-morning-cutoff-error"
            />
          </div>
        </div>
        <RuleHistory lines={nextMorningHistoryLines(history)} testId="next-morning-history" />
      </SettingBlock>

      <SettingBlock
        {...block("staff-next-morning-from")}
        labelFor="staff-next-morning-from-date"
        defaultText="The day the rule was installed"
        affects={[
          {
            where: "Staff Attendance",
            what: "days before this date keep the forgotten last-out window below, even when their month is worked out again",
            to: "/hr/attendance/staff",
          },
          { where: "Staff Payroll", what: "payslips already generated are never rewritten", to: "/hr/payroll" },
        ]}
        note="It can only be moved later, never back and never before today: days already judged keep their old rule."
      >
        <div className="space-y-1" data-testid="next-morning-from">
          <Input
            id="staff-next-morning-from-date"
            type="date"
            value={draft.nextMorningFrom}
            min={minDate}
            disabled={locked}
            aria-invalid={errors.nextMorningFrom ? true : undefined}
            onChange={(e) => patch({ nextMorningFrom: e.target.value })}
            className={cn("w-44", errors.nextMorningFrom && "border-red-400")}
          />
          {errors.nextMorningFrom ? (
            <p role="alert" className="text-xs font-medium text-red-600" data-testid="next-morning-from-error">
              {errors.nextMorningFrom}
            </p>
          ) : (
            <p className="text-xs text-gray-500" data-testid="next-morning-from-note">
              {draft.nextMorningFrom
                ? `From ${dayText(draft.nextMorningFrom)} on.`
                : "Not set yet: the server sets it when the rule is installed."}
            </p>
          )}
        </div>
      </SettingBlock>
    </SettingsSection>
  );
}
