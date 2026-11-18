import { Sunrise } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Field, ToggleField } from "../kit/Field";
import { PreviewCard, PreviewLine, SettingBlock, SettingsSection } from "../kit/SettingBlock";
import { PRODUCTION_SHIFT_SECTIONS, productionShiftText } from "../ProductionShiftsTab.meta";
import { clockInExample, cutOffTime, doubleTapExample, morningRows } from "./night-morning";
import { clock12 } from "./time";
import type { ShiftRulesDraft } from "./form";
import type { SectionProps } from "./ui";

const block = (id: string) => ({ id, ...productionShiftText(id) });

const ATTENDANCE = { where: "Production Attendance", to: "/hr/attendance/production" };
const PAYROLL = { where: "Production Payroll", to: "/hr/production-payroll" };

type MinutesKey =
  "earlyArrivalMinutes" | "clockInAgainMinutes" | "cutOffMinutes" | "doubleTapMinutes" | "nightSessionHours";

/** A whole-number box with its unit. Greyed out (its value kept) while the rule's switch is off. */
function MinutesBox({
  id,
  label,
  unit,
  draftKey,
  draft,
  patch,
  disabled,
  error,
}: {
  id: string;
  label: string;
  unit: string;
  draftKey: MinutesKey;
  draft: ShiftRulesDraft;
  patch: SectionProps["patch"];
  disabled: boolean;
  error: string | null;
}) {
  return (
    <Field label={label} htmlFor={id} unit={unit} error={error}>
      <Input
        id={id}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        value={draft[draftKey]}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        onChange={(e) => patch({ [draftKey]: e.target.value } as Partial<ShiftRulesDraft>)}
        className={cn("w-24 tabular-nums", error && "border-red-400")}
      />
    </Field>
  );
}

/**
 * Night and early morning (owner 2026-11-18: "configure the shift timings and overtime rules from this tab, nothing
 * hardcoded"): which day a next-morning punch belongs to. Every rule has a switch and its minutes, and a worked example
 * from the groups on the tab. The engine (production_shift_rules.py) follows what is saved here.
 */
export function NightMorningSection({ draft, patch, readOnly, validation }: SectionProps) {
  const rows = morningRows(draft);
  const dayRows = rows.filter((r) => !r.night);
  const nightRows = rows.filter((r) => r.night);
  const cutOff = cutOffTime(draft);
  const tap = doubleTapExample(draft);

  return (
    <SettingsSection
      id="production-shifts-night"
      icon={Sunrise}
      title={PRODUCTION_SHIFT_SECTIONS.night}
      purpose="A shift that runs past midnight ends with a punch the next morning. These rules decide whether a morning punch ends the night before (its overtime stays on the day it began) or starts the new day. Each one can be switched off or changed."
      testId="production-shifts-night"
    >
      <SettingBlock
        {...block("early-arrival")}
        labelFor="production-early-arrival-switch"
        defaultText="On, 150 minutes (6:00 AM for an 8:30 AM shift)"
        affects={[
          {
            ...ATTENDANCE,
            what: "a worker who forgot to punch out keeps the next morning's early arrival as that day's first punch",
          },
          { ...PAYROLL, what: "the evening before is not paid as overtime up to that arrival" },
        ]}
        preview={
          dayRows.length > 0 && (
            <PreviewCard
              title="With your shifts"
              scenario="A day shift left open the evening before (no out-punch), then a punch the next morning."
              testId="early-arrival-example"
            >
              {dayRows.map((r) => (
                <PreviewLine
                  key={r.group}
                  label={`${r.group}, starts ${clock12(r.start)}`}
                  result={
                    draft.earlyArrivalEnabled
                      ? `From ${clock12(r.arrivalFrom)}: the day's arrival`
                      : "Any morning punch can end the night"
                  }
                  tone={draft.earlyArrivalEnabled ? "info" : "warn"}
                />
              ))}
            </PreviewCard>
          )
        }
      >
        <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
          <ToggleField
            id="production-early-arrival-switch"
            checked={draft.earlyArrivalEnabled}
            onChange={(v) => patch({ earlyArrivalEnabled: v })}
            onLabel="Early arrivals start the new day"
            offLabel="Early arrivals are not protected"
            disabled={readOnly}
          >
            Before this time a morning punch always ends the night.
          </ToggleField>
          <MinutesBox
            id="production-early-arrival-minutes"
            label="From"
            unit="min before the shift start"
            draftKey="earlyArrivalMinutes"
            draft={draft}
            patch={patch}
            disabled={readOnly || !draft.earlyArrivalEnabled}
            error={validation.earlyArrival}
          />
        </div>
      </SettingBlock>

      <SettingBlock
        {...block("clock-in-again")}
        labelFor="production-clock-in-again-switch"
        defaultText="On, 15 minutes (by 8:45 AM)"
        affects={[
          {
            ...ATTENDANCE,
            what: "overtime worked through the night until after the early-arrival time stays on the day it began",
          },
          { ...PAYROLL, what: "that night's overtime is paid on the day it began" },
        ]}
        preview={
          dayRows.length > 0 && (
            <PreviewCard
              title="With your shifts"
              scenario="Overtime through the night, out in the early morning, in again for the next shift."
              testId="clock-in-again-example"
            >
              {dayRows.map((r) => {
                const x = clockInExample(draft, r);
                return (
                  <PreviewLine
                    key={r.group}
                    label={`${r.group}: out ${clock12(x.out)}, in ${clock12(x.again)}`}
                    result={x.endsNight ? `${clock12(x.out)} ends the night` : `${clock12(x.out)} is the arrival`}
                    tone={x.endsNight ? "good" : "warn"}
                  />
                );
              })}
            </PreviewCard>
          )
        }
      >
        <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
          <ToggleField
            id="production-clock-in-again-switch"
            checked={draft.clockInAgainEnabled}
            onChange={(v) => patch({ clockInAgainEnabled: v })}
            onLabel="A clock-in for the shift makes the early punch the night's exit"
            offLabel="An early punch is always the arrival"
            disabled={readOnly || !draft.earlyArrivalEnabled}
          >
            Only used while early arrivals are on.
          </ToggleField>
          <MinutesBox
            id="production-clock-in-again-minutes"
            label="Clock-in by"
            unit="min after the shift start"
            draftKey="clockInAgainMinutes"
            draft={draft}
            patch={patch}
            disabled={readOnly || !draft.earlyArrivalEnabled || !draft.clockInAgainEnabled}
            error={validation.clockInAgain}
          />
        </div>
      </SettingBlock>

      <SettingBlock
        {...block("night-exit")}
        labelFor="production-night-exit-switch"
        defaultText="On"
        affects={[{ ...ATTENDANCE, what: "a night shift's morning out-punch is counted on the night it began" }]}
        preview={
          nightRows.length > 0 && (
            <PreviewCard
              title="With your shifts"
              scenario="In at night, out the next morning."
              testId="night-exit-example"
            >
              {nightRows.map((r) => (
                <PreviewLine
                  key={r.group}
                  label={`${r.group}, starts ${clock12(r.start)}`}
                  result={
                    draft.nightExitEnabled || !draft.earlyArrivalEnabled
                      ? "Its morning out-punch ends the night"
                      : `A morning punch from ${clock12(dayRows[0]?.arrivalFrom ?? r.arrivalFrom)} can start a new day`
                  }
                  tone={draft.nightExitEnabled || !draft.earlyArrivalEnabled ? "good" : "warn"}
                />
              ))}
            </PreviewCard>
          )
        }
      >
        <ToggleField
          id="production-night-exit-switch"
          checked={draft.nightExitEnabled}
          onChange={(v) => patch({ nightExitEnabled: v })}
          onLabel="Night shifts keep their morning exit"
          offLabel="The early-arrival rule applies to night shifts too"
          disabled={readOnly || !draft.earlyArrivalEnabled}
        >
          A night shift is one whose end is the next morning.
        </ToggleField>
      </SettingBlock>

      <SettingBlock
        {...block("cut-off")}
        labelFor="production-cut-off-switch"
        defaultText="On, 90 minutes after the latest next-morning leaving time"
        affects={[{ ...ATTENDANCE, what: "a morning punch after this time never ends the night before" }]}
        note="Off: only the night session length below limits it, so an ordinary arrival after a forgotten out-punch can end the night before unless the early-arrival rule keeps it."
        preview={
          <PreviewCard
            title="With your shifts"
            scenario="The latest a morning punch can still end the night."
            testId="cut-off-example"
          >
            <PreviewLine
              label="Next-morning cut-off"
              result={cutOff === null ? "No cut-off" : clock12(cutOff)}
              tone={cutOff === null ? "warn" : "info"}
            />
          </PreviewCard>
        }
      >
        <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
          <ToggleField
            id="production-cut-off-switch"
            checked={draft.cutOffEnabled}
            onChange={(v) => patch({ cutOffEnabled: v })}
            onLabel="Morning punches after the cut-off start the new day"
            offLabel="No cut-off"
            disabled={readOnly}
          />
          <MinutesBox
            id="production-cut-off-minutes"
            label="Cut-off"
            unit="min after the latest next-morning leaving time"
            draftKey="cutOffMinutes"
            draft={draft}
            patch={patch}
            disabled={readOnly || !draft.cutOffEnabled}
            error={validation.cutOff}
          />
        </div>
      </SettingBlock>

      <SettingBlock
        {...block("night-session")}
        labelFor="production-night-hours"
        defaultText="24 hours"
        affects={[
          {
            ...ATTENDANCE,
            what: "a morning punch more than this many hours after the open punch never ends the night",
          },
          {
            where: "HR Reports",
            what: "Production Daily Punches shows the next-morning punch on the day the night began",
            to: "/hr/reports",
          },
        ]}
      >
        <MinutesBox
          id="production-night-hours"
          label="Night session length"
          unit="hours"
          draftKey="nightSessionHours"
          draft={draft}
          patch={patch}
          disabled={readOnly}
          error={validation.nightHours}
        />
      </SettingBlock>

      <SettingBlock
        {...block("double-tap")}
        labelFor="production-double-tap-switch"
        defaultText="On, 5 minutes"
        affects={[{ ...ATTENDANCE, what: "a second press on the device is not counted as an out-punch" }]}
        preview={
          <PreviewCard
            title="Worked example"
            scenario={`Two presses ${tap.gap} minutes apart.`}
            testId="double-tap-example"
          >
            <PreviewLine
              label="8:30 AM and 8:33 AM"
              result={tap.onePunch ? "One punch" : "Two punches (an in and an out)"}
              tone={tap.onePunch ? "good" : "warn"}
            />
          </PreviewCard>
        }
      >
        <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
          <ToggleField
            id="production-double-tap-switch"
            checked={draft.doubleTapEnabled}
            onChange={(v) => patch({ doubleTapEnabled: v })}
            onLabel="Double taps are ignored"
            offLabel="Every press counts"
            disabled={readOnly}
          />
          <MinutesBox
            id="production-double-tap-minutes"
            label="Within"
            unit="min of the previous punch"
            draftKey="doubleTapMinutes"
            draft={draft}
            patch={patch}
            disabled={readOnly || !draft.doubleTapEnabled}
            error={validation.doubleTap}
          />
        </div>
      </SettingBlock>
    </SettingsSection>
  );
}
