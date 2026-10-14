import { CalendarCheck2 } from "lucide-react";
import {
  arrivalLimits,
  clock,
  minutesOf,
  shiftsFor,
  type ArrivalSettings,
  type ArrivalZone,
} from "@/lib/arrival-rules";
import { PreviewCard, PreviewLine, SettingBlock, SettingsSection } from "../kit/SettingBlock";
import { describeShift, payFor, rupees, shiftText, type ExampleShift } from "./example";
import type { StaffAccess, StaffDraft, StaffErrors } from "./form";
import { PERMISSION_MINUTES, judgeStaffDay, statusLabel, type StaffDay } from "./preview";
import { SettingLink } from "./SettingLink";
import { UnitInput } from "./UnitInput";

const COMPANY_WIDE_NOTE = "Company-wide rule - set by an administrator";
const NOT_REPORTED_NOTE = "Not reported by the server, so it cannot be changed here";

type Props = {
  draft: StaffDraft;
  patch: (p: Partial<StaffDraft>) => void;
  errors: StaffErrors;
  access: StaffAccess;
  /** The saved settings have arrived (until then nothing can be typed). */
  loaded: boolean;
  shift: ExampleShift | null;
  arrival: ArrivalSettings;
  /** The retired fixed first-half end the engine still uses for staff with no shift. */
  fixedFirstHalfEnd: string | null;
};

const money = (shifts: number) => `${shiftText(shifts)} = ${rupees(payFor(shifts))}`;

function dayResult(day: StaffDay): string {
  const parts = [statusLabel(day.status)];
  if (day.zone === "quarter" && day.status === "present") parts.push("quarter shift");
  if (day.late) parts.push("Late");
  return `${parts.join(", ")} · ${money(day.shifts)}`;
}

/** Full Day / Half Day / Absent: the morning arrival timeline (four numbers) and Second Half Start. */
export function DaySection({ draft, patch, errors, access, loaded, shift, arrival, fixedFirstHalfEnd }: Props) {
  const arrivalLocked = !loaded || !access.companyWideEditable || !access.arrivalReported;
  const halfDayLocked = !loaded || !access.companyWideEditable || !access.halfDayReported;
  const limits = shift && !errors.arrival ? arrivalLimits(clock(shift.start), shift.grace, arrival) : null;
  const secondHalf = minutesOf(draft.secondHalfStart);
  const lateOn = draft.morningLateInEnabled !== false;
  const q = Number.isFinite(arrival.quarterDeduction) ? arrival.quarterDeduction : 0;

  const judge = (punches: number[], opts: { permission?: boolean } = {}) =>
    shift && secondHalf !== null
      ? judgeStaffDay({
          punches,
          shift,
          arrival,
          secondHalfStart: secondHalf,
          morningLateIn: lateOn,
          eveningEarlyOut: false,
          morningPermission: opts.permission,
        })
      : null;

  const scenario = shift ? `For the example: ${describeShift(shift)}.` : undefined;
  const noExample = (
    <p className="text-[12px] text-gray-500">Enter a valid example shift and valid numbers to see it.</p>
  );

  // ── worked examples ──
  const quarterAt = limits ? Math.min(limits.lateUntil + 20, limits.firstHalfUntil) : null;
  const quarterDay =
    limits && quarterAt !== null && quarterAt > limits.lateUntil ? judge([quarterAt, shift!.end + 5]) : null;
  const extraAt = limits
    ? limits.permissionUntil + Math.max(1, Math.round((limits.firstHalfUntil - limits.permissionUntil) / 4))
    : null;
  const extraDay =
    limits && extraAt !== null && limits.firstHalfUntil > limits.permissionUntil
      ? judge([extraAt, shift!.end + 5], { permission: true })
      : null;
  const missedAlone = limits ? judge([limits.firstHalfUntil + 1]) : null;
  const missedThenEvening = limits ? judge([limits.firstHalfUntil + 1, shift!.end + 5]) : null;

  return (
    <SettingsSection
      id="attendance-day"
      icon={CalendarCheck2}
      title="Full Day, Half Day or Absent"
      purpose="Where the first punch falls after the shift starts, and whether there is a punch in the afternoon, decide what a staff day earns. Both modes use these rules, and they are company-wide."
      usedBy={[
        { label: "Staff Attendance", to: "/hr/attendance/staff" },
        { label: "Staff Payroll", to: "/hr/payroll" },
        { label: "Employee apps" },
      ]}
      testId="attendance-day-section"
    >
      <div data-testid="arrival-timeline">
        <SettingBlock
          id="late-window"
          labelFor="arrival-late-window"
          title="Late window (minutes)"
          purpose="How long after the shift start plus its grace a first punch is only Late: the day stays a Full Day but counts one mark in the monthly late pool. A later arrival is not Late: it becomes a quarter-shift day (or is excused by a permission)."
          affects={[
            {
              where: "Staff Attendance",
              what: "first punches inside the window get the Late badge (while Morning Late-In is on)",
              to: "/hr/attendance/staff",
            },
            {
              where: "Late Detection",
              what: "each Late day is one mark in the monthly pool; marks beyond the free allowance are deducted from salary",
              to: "/hr/settings?tab=late_detection",
            },
            {
              where: "WhatsApp late alert",
              what: "is only sent for an arrival inside this window",
              to: "/hr/whatsapp-control",
            },
            {
              where: "Half-Day Detection",
              what: "the latest first punch that still makes the morning half is start + grace + all three windows",
            },
            { where: "Dashboard, reports and employee apps", what: "count Late days with the same window" },
          ]}
          defaultText="60 minutes"
          note="Measured from each shift's own start and grace. Changing it re-judges past days too (see Save)."
          preview={
            <PreviewCard title="Example" scenario={scenario}>
              {limits ? (
                <>
                  <PreviewLine label={`On time up to ${clock(limits.onTimeUntil)}`} result="Full Day" tone="good" />
                  {limits.lateUntil > limits.onTimeUntil ? (
                    <PreviewLine
                      label={`${clock(limits.onTimeUntil + 1)} - ${clock(limits.lateUntil)}`}
                      result={lateOn ? "Late: Full Day + 1 mark" : "Full Day, no mark (Morning Late-In is off)"}
                      tone="warn"
                    />
                  ) : (
                    <PreviewLine label="Late window 0" result="nobody is ever Late" tone="info" />
                  )}
                  <PreviewLine
                    label={`From ${clock(limits.lateUntil + 1)}`}
                    result="not Late: quarter shift, or excused by a permission"
                    tone="info"
                  />
                </>
              ) : (
                noExample
              )}
            </PreviewCard>
          }
        >
          <UnitInput
            id="arrival-late-window"
            value={draft.lateWindow}
            onChange={(v) => patch({ lateWindow: v })}
            unit="minutes"
            step={5}
            min={0}
            max={240}
            disabled={arrivalLocked}
            invalid={!!errors.lateWindow}
          />
        </SettingBlock>

        <SettingBlock
          id="permission-window"
          labelFor="arrival-permission-window"
          title="Permission window (minutes)"
          purpose="Minutes after the Late window up to which an approved Morning Late-In permission (within the monthly cap) still excuses the arrival: a Full Day and no Late mark. Without such a permission these arrivals are quarter-shift days."
          affects={[
            {
              where: "Staff Attendance",
              what: "decides 'excused by permission' versus 'quarter shift' for these arrivals",
              to: "/hr/attendance/staff",
            },
            { where: "WhatsApp late alert", what: "is not sent while a permission covers the arrival" },
            {
              where: "Permissions",
              what: "only approvals within the Permission Monthly Cap get this window",
              to: "/hr/settings?tab=late_detection",
            },
            { where: "Employee apps", what: "show the same limit to the employee" },
          ]}
          defaultText="60 minutes"
          note="Not the same as the Afternoon permission zone (lunch return) or the monthly permission cap."
          preview={
            <PreviewCard title="Example" scenario={scenario}>
              {limits ? (
                <>
                  <PreviewLine
                    label="With an approved permission"
                    result={`excused up to ${clock(limits.permissionUntil)}: Full Day, no mark`}
                    tone="good"
                  />
                  {limits.permissionUntil > limits.lateUntil && (
                    <PreviewLine
                      label={`Without one, ${clock(limits.lateUntil + 1)} - ${clock(limits.permissionUntil)}`}
                      result={`quarter shift: ${money(shiftsFor("quarter", q))}`}
                      tone="warn"
                    />
                  )}
                  <PreviewLine
                    label={`A permission is "${PERMISSION_MINUTES} minutes", yet it excuses arrivals up to`}
                    result={`${limits.permissionUntil - limits.onTimeUntil} minutes after the grace (Late + Permission window)`}
                    tone="info"
                  />
                </>
              ) : (
                noExample
              )}
            </PreviewCard>
          }
        >
          <UnitInput
            id="arrival-permission-window"
            value={draft.permissionWindow}
            onChange={(v) => patch({ permissionWindow: v })}
            unit="minutes"
            step={5}
            min={0}
            max={240}
            disabled={arrivalLocked}
            invalid={!!errors.permissionWindow}
          />
        </SettingBlock>

        <SettingBlock
          id="extra-minutes"
          labelFor="arrival-extra"
          title="Extra minutes"
          purpose="A last stretch after the Permission window: an arrival in it still makes the morning half (the day is not cut to a Half Day) but always takes the quarter-shift deduction. A permission never covers these minutes."
          affects={[
            {
              where: "Half-Day Detection",
              what: "sets the first-half limit: the latest first punch that still makes the morning half",
            },
            {
              where: "Staff Attendance",
              what: "'Quarter shift' up to the limit, 'Evening half only' after it",
              to: "/hr/attendance/staff",
            },
            { where: "Employee apps", what: "show the same limit" },
          ]}
          defaultText="20 minutes"
          preview={
            <PreviewCard title="Example" scenario={scenario}>
              {limits ? (
                <>
                  <PreviewLine
                    label="Morning half made up to (first-half limit)"
                    result={clock(limits.firstHalfUntil)}
                    tone="info"
                  />
                  {extraDay && extraAt !== null && (
                    <PreviewLine
                      label={`First punch ${clock(extraAt)}, even with a permission`}
                      result={dayResult(extraDay)}
                      tone="warn"
                    />
                  )}
                  {missedAlone && missedThenEvening && (
                    <PreviewLine
                      label={`First punch ${clock(limits.firstHalfUntil + 1)}`}
                      result={`${statusLabel(missedAlone.status)} alone; with a punch at ${clock(shift!.end + 5)}: ${dayResult(missedThenEvening)}`}
                      tone="bad"
                    />
                  )}
                </>
              ) : (
                noExample
              )}
            </PreviewCard>
          }
        >
          <UnitInput
            id="arrival-extra"
            value={draft.extraMinutes}
            onChange={(v) => patch({ extraMinutes: v })}
            unit="minutes"
            step={5}
            min={0}
            max={240}
            disabled={arrivalLocked}
            invalid={!!errors.extraMinutes}
          />
        </SettingBlock>

        <SettingBlock
          id="quarter-deduction"
          labelFor="arrival-deduction"
          title="Quarter-shift deduction (shifts)"
          purpose="How much of the day's pay is taken off for an arrival after the Late window that no permission covers, while still inside the morning half. It replaces the Late mark for that day: never both."
          affects={[
            {
              where: "Staff Payroll",
              what: "the day earns 1 minus this; salary = daily rate x days earned",
              to: "/hr/payroll",
            },
            { where: "Staff Attendance", what: "the day shows the 'Quarter shift' badge", to: "/hr/attendance/staff" },
            { where: "Payslip breakdown and employee apps", what: "show the deduction" },
          ]}
          defaultText="0.25 shift"
          note={
            <>
              Changes pay for every staff member. 0 makes these arrivals cost nothing (and they are not Late either). 1
              shows the day as 0.00 in attendance, but payroll pays a present day with 0 shifts as a full day, so use
              less than 1. A day that is already a Half Day is not docked again.
            </>
          }
          preview={
            <PreviewCard title="Example" scenario={scenario}>
              {limits && quarterDay && quarterAt !== null ? (
                <>
                  <PreviewLine
                    label={`First punch ${clock(quarterAt)}, last ${clock(shift!.end + 5)}, no permission`}
                    result={dayResult(quarterDay)}
                    tone={quarterDay.shifts < 1 ? "warn" : "good"}
                  />
                  <PreviewLine
                    label="Compared with a full day"
                    result={
                      quarterDay.shifts === 0
                        ? `attendance shows 0.00, but payroll pays it as a full day (${rupees(payFor(1))})`
                        : `${rupees(payFor(1) - payFor(quarterDay.shifts))} less than ${rupees(payFor(1))}`
                    }
                    tone={quarterDay.shifts === 0 ? "bad" : "neutral"}
                  />
                </>
              ) : limits ? (
                <PreviewLine
                  label="No quarter-shift arrivals"
                  result="the Permission window and Extra minutes are both 0"
                  tone="info"
                />
              ) : (
                noExample
              )}
            </PreviewCard>
          }
        >
          <UnitInput
            id="arrival-deduction"
            value={draft.quarterDeduction}
            onChange={(v) => patch({ quarterDeduction: v })}
            unit="shift"
            step={0.05}
            min={0}
            max={1}
            disabled={arrivalLocked}
            invalid={!!errors.quarterDeduction}
          />
        </SettingBlock>

        {errors.arrival && (
          <p role="alert" data-testid="arrival-error" className="pb-2 text-xs font-medium text-red-600">
            {errors.arrival}
          </p>
        )}
        {!access.companyWideEditable && (
          <p data-testid="company-wide-note-arrival" className="pb-2 text-[11px] font-medium text-slate-500">
            {COMPANY_WIDE_NOTE}
          </p>
        )}
        {access.companyWideEditable && loaded && !access.arrivalReported && (
          <p data-testid="arrival-not-reported" className="pb-2 text-[11px] font-medium text-slate-500">
            {NOT_REPORTED_NOTE}
          </p>
        )}

        <SettingBlock
          id="second-half-start"
          labelFor="half-day-second-half-start"
          title="Second Half Start Time"
          purpose="The clock time after which any punch counts as having worked the afternoon half. Together with the morning half (a first punch by the first-half limit) it decides the day: both halves = Full Day, one = Half Day, neither = Absent."
          affects={[
            {
              where: "Staff Attendance",
              what: "Full Day, Half Day or Absent, and the reason 'no punch at or after' this time",
              to: "/hr/attendance/staff",
            },
            { where: "Staff Payroll", what: "a Half Day earns 0.5 of the day", to: "/hr/payroll" },
            {
              where: "Compensation",
              what: "a company-announced early-out time (or a Compensation Day's release time) replaces it for that one day",
              to: "/hr/compensation",
            },
            { where: "Employee apps", what: "the My Shift screen shows this time" },
          ]}
          defaultText="14:30"
          note={
            <>
              One time for every shift. Staff with no shift have no first-half limit: for them a punch before the old
              fixed first-half end ({fixedFirstHalfEnd || "13:30"}) counts as the morning half, and that time cannot be
              changed here.
            </>
          }
          preview={
            <PreviewCard title="Example days" scenario={scenario}>
              {shift && limits && secondHalf !== null
                ? (
                    [
                      [shift.start + 5, shift.end - 10],
                      [shift.start + 5, shift.lunchStart - 30],
                      [secondHalf + 15],
                      [limits.firstHalfUntil + 30],
                    ] as number[][]
                  ).map((punches, i) => {
                    const day = judge(punches)!;
                    return (
                      <PreviewLine
                        key={i}
                        label={
                          punches.length === 1
                            ? `One punch at ${clock(punches[0])}`
                            : `In ${clock(punches[0])}, out ${clock(punches[1])}`
                        }
                        result={dayResult(day)}
                        tone={day.status === "present" ? "good" : day.status === "half_shift" ? "warn" : "bad"}
                      />
                    );
                  })
                : noExample}
            </PreviewCard>
          }
        >
          <UnitInput
            id="half-day-second-half-start"
            type="time"
            value={draft.secondHalfStart}
            onChange={(v) => patch({ secondHalfStart: v })}
            disabled={halfDayLocked}
            error={errors.secondHalfStart}
            errorTestId="half-day-error"
          />
          {!access.companyWideEditable && (
            <p data-testid="company-wide-note-half-day" className="text-[11px] font-medium text-slate-500">
              {COMPANY_WIDE_NOTE}
            </p>
          )}
          {access.companyWideEditable && loaded && !access.halfDayReported && (
            <p data-testid="half-day-not-reported" className="text-[11px] font-medium text-slate-500">
              {NOT_REPORTED_NOTE}
            </p>
          )}
        </SettingBlock>

        <ArrivalTimelinePreview
          shift={shift}
          arrival={arrival}
          valid={!errors.arrival}
          secondHalfStart={draft.secondHalfStart}
          lateOn={lateOn}
        />
      </div>
      <p className="mt-3 text-[12px] text-gray-500">
        What a Late mark costs is set on{" "}
        <SettingLink tab="late_detection" setting="free-allowance">
          Late Detection
        </SettingLink>
        ; whether Late is marked at all is the Morning Late-In switch below.
      </p>
      <div
        className="settings-clay-inset mt-3 p-3 text-[12px] leading-relaxed text-gray-600"
        data-testid="first-half-meanings"
      >
        <p className="font-bold text-gray-800">&quot;First half&quot; means three different things in the portal</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-4">
          <li>
            <b>The first-half limit</b> above (shift start + grace + the three windows
            {limits ? `, ${clock(limits.firstHalfUntil)} for the example` : ""}): the latest first punch that still
            makes the morning half. This is what decides a Half Day.
          </li>
          <li>
            <b>&quot;First half ends&quot;</b> on a shift in Manage Shift: when its lunch starts. Used only by Strict
            mode&apos;s lunch check and the WhatsApp lunch reminders, never to decide a Half Day.
          </li>
          <li>
            <b>The old fixed first-half end</b> ({fixedFirstHalfEnd || "13:30"}): kept only for staff with no shift (any
            punch before it is their morning half) and for days entered by hand. It cannot be changed here.
          </li>
        </ul>
      </div>
    </SettingsSection>
  );
}

const ZONE_ROWS: { zone: ArrivalZone; label: string }[] = [
  { zone: "on_time", label: "On time: a Full Day" },
  { zone: "late", label: "Late: a Full Day, counted in the late pool" },
  {
    zone: "excused",
    label: "With an approved Morning Late-In permission (within the monthly cap): a Full Day and no Late mark",
  },
  { zone: "quarter", label: "Quarter-shift arrival (a permission does not cover the extra minutes)" },
  {
    zone: "second_half",
    label: "First half missed: Absent until a punch at or after Second Half Start, then Half Day",
  },
];

/** The whole morning for the example shift: every zone as clock times, with what a day worked to the evening earns. */
function ArrivalTimelinePreview({
  shift,
  arrival,
  valid,
  secondHalfStart,
  lateOn,
}: {
  shift: ExampleShift | null;
  arrival: ArrivalSettings;
  valid: boolean;
  secondHalfStart: string;
  lateOn: boolean;
}) {
  const limits = shift && valid ? arrivalLimits(clock(shift.start), shift.grace, arrival) : null;
  const secondStart = minutesOf(secondHalfStart);
  const range = (zone: ArrivalZone): string => {
    if (!limits) return "-";
    const { onTimeUntil, lateUntil, permissionUntil, firstHalfUntil } = limits;
    switch (zone) {
      case "on_time":
        return `up to ${clock(onTimeUntil)}`;
      case "late":
        return lateUntil > onTimeUntil ? `${clock(onTimeUntil + 1)} - ${clock(lateUntil)}` : "none";
      case "excused":
        return permissionUntil > onTimeUntil
          ? `${clock(onTimeUntil + 1)} - ${clock(permissionUntil)} (with a permission)`
          : "none";
      case "quarter":
        return firstHalfUntil > lateUntil ? `${clock(lateUntil + 1)} - ${clock(firstHalfUntil)}` : "none";
      default:
        return `after ${clock(firstHalfUntil)}`;
    }
  };
  return (
    <div className="pt-1" data-testid="arrival-preview">
      <PreviewCard
        title="The whole morning for the example shift"
        scenario={
          shift
            ? `Where a first punch falls for ${describeShift(shift)}, and what the day earns when it is worked to the evening.`
            : undefined
        }
      >
        {!limits ? (
          <p className="text-[12px] text-slate-500">
            Enter a valid shift start and valid numbers above to see the timeline.
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <tbody>
                  {ZONE_ROWS.map(({ zone, label }) => {
                    const shifts = shiftsFor(zone, arrival.quarterDeduction);
                    return (
                      <tr key={zone} data-testid={`arrival-preview-${zone}`} className="border-t border-blue-100/70">
                        <td className="whitespace-nowrap py-1.5 pr-3 font-mono text-slate-800">{range(zone)}</td>
                        <td className="py-1.5 text-slate-600">
                          {zone === "late" && !lateOn
                            ? "Late window (no mark while Morning Late-In is off): a Full Day"
                            : label}
                        </td>
                        <td className="whitespace-nowrap py-1.5 pl-3 text-right font-semibold text-slate-800">
                          {shiftText(shifts)}{" "}
                          <span className="font-normal text-slate-500">({rupees(payFor(shifts))})</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-slate-500">
              A first punch after {clock(limits.firstHalfUntil)} earns the Half Day once a punch at or after Second Half
              Start ({secondHalfStart || "-"}) is recorded.
            </p>
            {secondStart !== null && limits.firstHalfUntil >= secondStart && (
              <p role="alert" data-testid="arrival-preview-warning" className="text-[12px] font-medium text-amber-700">
                For this shift the first-half limit ({clock(limits.firstHalfUntil)}) is not before Second Half Start (
                {secondHalfStart}): a single punch in between would count as both halves, a Full Day. Shorten a window
                or move Second Half Start later.
              </p>
            )}
          </>
        )}
      </PreviewCard>
    </div>
  );
}
