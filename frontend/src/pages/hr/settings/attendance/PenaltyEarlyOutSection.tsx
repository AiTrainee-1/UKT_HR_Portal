import { TimerOff } from "lucide-react";
import { clock } from "@/lib/arrival-rules";
import { cn } from "@/lib/utils";
import { PreviewCard, PreviewLine, SettingBlock, SettingsSection } from "../kit/SettingBlock";
import { ToggleField } from "../kit/Field";
import { describeShift, payFor, rupees, EXAMPLE_PAY_LINE, type ExampleShift } from "./example";
import { num, type StaffAccess, type StaffDraft, type StaffErrors } from "./form";
import { PERMISSION_MINUTES, penaltyEarlyOut, type PenaltySettings } from "./preview";
import { SettingLink } from "./SettingLink";
import { UnitInput } from "./UnitInput";

const COMPANY_WIDE_NOTE = "Company-wide rule - set by an administrator";
const NOT_REPORTED_NOTE = "Not reported by the server, so it cannot be changed here";

const FROM_CHOICES: { value: StaffDraft["earlyOutPenaltyFrom"]; title: string; text: string }[] = [
  {
    value: "shift_end",
    title: "The shift end",
    text: "Minutes are counted back from the shift's end time. The usual rule.",
  },
  {
    value: "deadline",
    title: "The Early-Out deadline",
    text: "Minutes are counted back from the shift end minus its grace, where an ordinary Early Out starts.",
  },
];

/** The settings of the draft as the engine reads them; null while a number is not valid. */
export function penaltyOf(draft: StaffDraft): PenaltySettings | null {
  const minutes = num(draft.earlyOutPenaltyMinutes);
  const deduction = num(draft.earlyOutPenaltyDeduction);
  if (!Number.isInteger(minutes) || minutes < 1 || !Number.isFinite(deduction) || deduction <= 0 || deduction > 1) {
    return null;
  }
  return {
    enabled: draft.earlyOutPenaltyEnabled === true,
    minutes,
    deduction,
    from: draft.earlyOutPenaltyFrom,
    inLatePool: draft.earlyOutPenaltyInLatePool,
  };
}

/**
 * Settings -> Attendance -> Staff -> Penalty Early Out (owner 2026-11-13): leaving MORE than N minutes (75) before the shift
 * end takes a part of a shift (0.25) off that day, charged on its own and not as a mark in the monthly late pool. Leaving
 * early by up to N minutes stays an ordinary Evening Early-Out. Twin of attendance_final.penalty_early_out_check.
 */
export function PenaltyEarlyOutSection({
  draft,
  patch,
  errors,
  access,
  loaded,
  shift,
}: {
  draft: StaffDraft;
  patch: (p: Partial<StaffDraft>) => void;
  errors: StaffErrors;
  access: StaffAccess;
  loaded: boolean;
  shift: ExampleShift | null;
}) {
  const on = draft.earlyOutPenaltyEnabled === true;
  const locked = !loaded || !access.companyWideEditable || !access.penaltyReported;
  const settings = penaltyOf(draft);
  const scenario = shift ? `For the example: ${describeShift(shift)}, ${EXAMPLE_PAY_LINE}.` : undefined;

  const examples = (() => {
    if (!shift || !settings) return null;
    const asOn = { ...settings, enabled: true };
    const rule = penaltyEarlyOut(shift.end, shift, asOn);
    const free = rule.latestFree; // leaving at this minute is still an ordinary Early-Out
    const hit = free - 15;
    const permitted = penaltyEarlyOut(shift.end, shift, asOn, true);
    return {
      reference: rule.reference,
      free,
      hit,
      hitMinutes: penaltyEarlyOut(hit, shift, asOn).minutesEarly,
      permittedFree: permitted.latestFree,
      cost: payFor(settings.deduction),
    };
  })();

  const disabledNote = loaded && !access.penaltyReported && (
    <p data-testid="penalty-not-reported" className="text-[11px] font-medium text-slate-500">
      {NOT_REPORTED_NOTE}
    </p>
  );

  return (
    <SettingsSection
      id="attendance-penalty-early-out"
      icon={TimerOff}
      title="Penalty Early Out"
      purpose="Leaving work long before the shift ends costs part of that day's pay straight away, separately from the late pool. Leaving a little early stays an ordinary Early Out mark."
      usedBy={[
        { label: "Staff Attendance", to: "/hr/attendance/staff" },
        { label: "Staff Payroll", to: "/hr/payroll" },
        { label: "Reports", to: "/hr/reports" },
      ]}
      testId="attendance-penalty-early-out"
    >
      <SettingBlock
        id="penalty-early-out"
        labelFor="penalty-early-out-switch"
        title="Penalty Early Out"
        purpose="Turns the penalty on or off. When on, a day whose last punch is more than the minutes below before the shift end loses the deduction below (a Full Day of 1.00 becomes 0.75). That day is not also an Early Out mark in the late pool."
        affects={[
          {
            where: "Staff Attendance",
            what: "a 'Penalty Early Out' badge, the minutes left early and the reduced day (0.75)",
            to: "/hr/attendance/staff",
          },
          {
            where: "Staff Payroll",
            what: "the reduced days are paid as worked days; the payslip breakdown lists the Penalty Early Out days, shifts and amount on their own",
            to: "/hr/payroll",
          },
          {
            where: "Late Detection",
            what: "a Penalty Early Out day is not counted in the free allowance or the deduction slabs (unless the last setting below says so)",
            to: "/hr/settings?tab=late_detection",
          },
          {
            where: "Report Center",
            what: "the Penalty Early Out report lists every such day with its amount",
            to: "/hr/reports",
          },
        ]}
        defaultText="Off"
        note={
          <>
            Turning it on adds a deduction for every staff member. It works whether or not Evening Early-Out marks are
            on. A Half Day (no punch after Second Half Start) is never also a Penalty Early Out, nor a day with an
            approved half-day leave, a half-day CL, a birthday or a compensation day. Today's day is judged only once
            the shift has ended (plus its grace), so a lunch punch is never taken for leaving early.
          </>
        }
        preview={
          <PreviewCard title="Example" scenario={scenario} testId="penalty-preview">
            {examples ? (
              <>
                <PreviewLine
                  label={`Last punch ${clock(examples.free)} (${settings!.minutes} min early)`}
                  result="ordinary Early Out, 1.00 shift"
                  tone="warn"
                  testId="penalty-preview-free"
                />
                <PreviewLine
                  label={`Last punch ${clock(examples.hit)} (${examples.hitMinutes} min early)`}
                  result={
                    on
                      ? `Penalty Early Out: ${(1 - settings!.deduction).toFixed(2)} shift, ${rupees(examples.cost)} less`
                      : "ordinary Early Out (the penalty is off)"
                  }
                  tone={on ? "bad" : "neutral"}
                  testId="penalty-preview-hit"
                />
                <PreviewLine
                  label={`With an approved Evening Early-Out permission (end moves ${PERMISSION_MINUTES} min earlier)`}
                  result={`penalty only before ${clock(examples.permittedFree)}`}
                  tone="info"
                />
              </>
            ) : (
              <p className="text-[12px] text-gray-500">Enter valid numbers to see it.</p>
            )}
          </PreviewCard>
        }
      >
        <ToggleField
          id="penalty-early-out-switch"
          checked={on}
          onChange={(v) => patch({ earlyOutPenaltyEnabled: v })}
          onLabel="Penalty Early Out is on"
          offLabel="Penalty Early Out is off"
          disabled={locked}
        >
          Leaving more than {draft.earlyOutPenaltyMinutes || "?"} minutes before the shift end costs{" "}
          {draft.earlyOutPenaltyDeduction || "?"} shift.
        </ToggleField>
        {disabledNote}
      </SettingBlock>

      <SettingBlock
        id="penalty-early-out-minutes"
        labelFor="penalty-early-out-minutes-input"
        title="Penalty after (minutes before the shift end)"
        purpose="Leaving MORE than this many minutes early is a Penalty Early Out. Leaving exactly this many minutes early, or less, is an ordinary Early Out mark (counted in the late pool while Evening Early-Out marks are on)."
        affects={[
          {
            where: "Staff Attendance and Payroll",
            what: "which early departures lose part of the day",
            to: "/hr/attendance/staff",
          },
        ]}
        defaultText="75 minutes, measured from the shift end"
        preview={
          examples ? (
            <PreviewCard title="Where the line falls" scenario={scenario}>
              <PreviewLine label="Measured from" result={clock(examples.reference)} tone="neutral" />
              <PreviewLine label={`Leaving at ${clock(examples.free)} or later`} result="no penalty" tone="good" />
              <PreviewLine
                label={`Leaving at ${clock(examples.free - 1)} or earlier`}
                result="Penalty Early Out"
                tone="bad"
              />
            </PreviewCard>
          ) : undefined
        }
      >
        <div className="space-y-3">
          <UnitInput
            id="penalty-early-out-minutes-input"
            value={draft.earlyOutPenaltyMinutes}
            onChange={(v) => patch({ earlyOutPenaltyMinutes: v })}
            unit="minutes early"
            step={5}
            min={1}
            max={720}
            disabled={locked}
            error={errors.earlyOutPenaltyMinutes}
            errorTestId="penalty-minutes-error"
          />
          <div role="radiogroup" aria-label="Penalty Early Out measured from" className="grid gap-2 sm:grid-cols-2">
            {FROM_CHOICES.map((c) => {
              const active = draft.earlyOutPenaltyFrom === c.value;
              return (
                <button
                  key={c.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={locked}
                  onClick={() => patch({ earlyOutPenaltyFrom: c.value })}
                  data-testid={`penalty-from-${c.value}`}
                  className={cn(
                    "rounded-2xl border-2 p-3 text-left transition-all disabled:cursor-not-allowed disabled:opacity-60",
                    active
                      ? "settings-clay !border-blue-400"
                      : "settings-glass !border-transparent hover:!border-blue-200",
                  )}
                >
                  <span className="text-sm font-bold text-gray-900">{c.title}</span>
                  <span className="mt-1 block text-xs leading-relaxed text-gray-500">{c.text}</span>
                </button>
              );
            })}
          </div>
          <p className="text-xs leading-snug text-gray-500">
            An approved Evening Early-Out permission within the monthly cap moves the end {PERMISSION_MINUTES} minutes
            earlier first, and a company-announced early-out replaces it (with no grace).
          </p>
        </div>
      </SettingBlock>

      <SettingBlock
        id="penalty-early-out-deduction"
        labelFor="penalty-early-out-deduction-input"
        title="Deduction per Penalty Early Out (shift)"
        purpose="How much of the day is taken off for each Penalty Early Out. 0.25 turns a Full Day (1.00) into 0.75. If the same day also had a quarter-shift arrival, both come off (0.50)."
        affects={[
          { where: "Staff Payroll", what: "the paid days of every month with a Penalty Early Out", to: "/hr/payroll" },
        ]}
        defaultText="0.25 shift"
        preview={
          examples && settings ? (
            <PreviewCard title="What it costs" scenario={scenario}>
              <PreviewLine
                label="Each Penalty Early Out"
                result={`${settings.deduction.toFixed(2)} shift = ${rupees(examples.cost)}`}
                tone="bad"
              />
              <PreviewLine
                label="Three in a month"
                result={`${(settings.deduction * 3).toFixed(2)} shift = ${rupees(payFor(settings.deduction * 3))}`}
                tone="bad"
              />
            </PreviewCard>
          ) : undefined
        }
      >
        <UnitInput
          id="penalty-early-out-deduction-input"
          value={draft.earlyOutPenaltyDeduction}
          onChange={(v) => patch({ earlyOutPenaltyDeduction: v })}
          unit="shift"
          step={0.25}
          min={0.01}
          max={1}
          disabled={locked}
          error={errors.earlyOutPenaltyDeduction}
          errorTestId="penalty-deduction-error"
        />
      </SettingBlock>

      <SettingBlock
        id="penalty-early-out-late-pool"
        labelFor="penalty-early-out-late-pool-switch"
        title="Also count it as an Early Out mark"
        purpose="Off (the usual rule): a Penalty Early Out is charged once, by the deduction above, and is not a mark in the monthly late pool. On: it is also one Early Out mark, so it uses up the free allowance and can reach the late deduction slabs."
        affects={[
          {
            where: "Late Detection and Staff Payroll",
            what: "whether Penalty Early Out days are added to the late pool count",
            to: "/hr/settings?tab=late_detection",
          },
        ]}
        defaultText="Off"
        note="On charges the same departure twice (the deduction above and a late-pool mark)."
      >
        <ToggleField
          id="penalty-early-out-late-pool-switch"
          checked={draft.earlyOutPenaltyInLatePool}
          onChange={(v) => patch({ earlyOutPenaltyInLatePool: v })}
          onLabel="Also counted in the late pool"
          offLabel="Charged on its own, not in the late pool"
          disabled={locked}
        />
      </SettingBlock>

      {!access.companyWideEditable && (
        <p data-testid="company-wide-note-penalty" className="text-[11px] font-medium text-slate-500">
          {COMPANY_WIDE_NOTE}
        </p>
      )}
      <p className="pt-2 text-[12px] text-gray-500">
        Ordinary Early Out marks:{" "}
        <SettingLink tab="attendance" setting="evening-early-out">
          Late and Early Out marks
        </SettingLink>
        {" - "}what they cost:{" "}
        <SettingLink tab="late_detection" setting="free-allowance">
          Late Detection
        </SettingLink>
      </p>
    </SettingsSection>
  );
}
