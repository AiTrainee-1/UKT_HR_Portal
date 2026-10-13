import { MoonStar } from "lucide-react";
import { clock } from "@/lib/arrival-rules";
import { PreviewCard, PreviewLine, SettingBlock, SettingsSection } from "../kit/SettingBlock";
import type { ExampleShift } from "./example";
import { num, type StaffDraft, type StaffErrors } from "./form";
import { claimedByDayBefore, forgottenExitRule, nextDayClock } from "./preview";
import { UnitInput } from "./UnitInput";

const AFFECTS = [
  {
    where: "Staff Attendance",
    what: "the day before gets its last punch back (its Early Out and Full Day / Half Day can change); the next day keeps its real first punch (and its Late mark)",
    to: "/hr/attendance/staff",
  },
  { where: "Staff Payroll", what: "pays the days as they are then judged", to: "/hr/payroll" },
];

/** A forgotten exit punch made after midnight: when it is given back to the day before. Staff only. */
export function MidnightSection({
  draft,
  patch,
  errors,
  loaded,
  shift,
}: {
  draft: StaffDraft;
  patch: (p: Partial<StaffDraft>) => void;
  errors: StaffErrors;
  loaded: boolean;
  shift: ExampleShift | null;
}) {
  const grace = num(draft.forgottenExitHours);
  const protection = num(draft.earlyArrivalProtectionHours);
  const valid = !errors.forgottenExitHours && !errors.earlyArrivalProtectionHours;
  // The engine reads the shift's end as a clock time, so a shift that ends after midnight has its end on that clock.
  const rule = shift && valid ? forgottenExitRule(shift.end % 1440, shift.start, grace, protection) : null;
  // Monday: in on time, forgot to punch out (last punch before the shift end); Tuesday: a punch after midnight.
  const forgotAt = shift ? shift.lunchStart + 45 : 0;
  const lateExit = 70; // 01:10 on Tuesday
  const tuesdayIn = shift ? shift.start + 2 : 0;

  const preview = (
    <PreviewCard
      title="Example"
      scenario={
        shift
          ? `Monday's shift ends ${clock(shift.end)} and Tuesday's starts ${clock(shift.start)}. On Monday the last punch is ${clock(forgotAt)} (no exit punch); the machine records a punch at ${clock(lateExit)} on Tuesday, then Tuesday's real arrival at ${clock(tuesdayIn)}.`
          : undefined
      }
    >
      {!shift || !valid ? (
        <p className="text-[12px] text-gray-500">Enter valid numbers to see it.</p>
      ) : !rule ? (
        <>
          <PreviewLine
            label="Given back to the day before"
            result={grace > 0 ? "nothing: the window ends before midnight" : "nothing: switched off (0)"}
            tone="neutral"
          />
          <PreviewLine
            label={`The ${clock(lateExit)} punch`}
            result="Tuesday's first punch; Monday has no exit punch"
            tone="bad"
          />
        </>
      ) : (
        <>
          <PreviewLine
            label={`${grace} h after ${clock(shift.end)} reaches`}
            result={nextDayClock(rule.reach)}
            tone="neutral"
          />
          {rule.protectedFrom !== null && (
            <PreviewLine
              label={`${protection} h before Tuesday's ${clock(shift.start)} start`}
              result={`stops it at ${nextDayClock(rule.protectedFrom)}`}
              tone="neutral"
            />
          )}
          <PreviewLine
            label="Punches given back to the day before"
            result={`up to ${nextDayClock(rule.cutoff)} (${rule.limitedBy === "protection" ? "the protection decides" : "the grace decides"})`}
            tone="info"
          />
          <PreviewLine
            label={`The ${clock(lateExit)} punch`}
            result={
              claimedByDayBefore(lateExit, forgotAt, shift.end % 1440, rule)
                ? `Monday's last punch; Tuesday starts at ${clock(tuesdayIn)}`
                : `Tuesday's first punch; Monday has no exit punch`
            }
            tone={claimedByDayBefore(lateExit, forgotAt, shift.end % 1440, rule) ? "good" : "bad"}
          />
          <PreviewLine
            label={`Had Monday a punch at ${clock(shift.end + 5)}`}
            result="Monday is complete, so the night punch stays Tuesday's"
            tone="neutral"
          />
        </>
      )}
    </PreviewCard>
  );

  // The protection block's own preview: where the next shift's start stops the window above.
  const protectionPreview = (
    <PreviewCard
      title="Example"
      scenario={
        shift ? `Tuesday's shift starts ${clock(shift.start)}; the window above reaches as far as it may.` : undefined
      }
      testId="protection-preview"
    >
      {!shift || !valid ? (
        <p className="text-[12px] text-gray-500">Enter valid numbers to see it.</p>
      ) : !rule ? (
        <PreviewLine
          label="Nothing to protect"
          result={
            grace > 0 ? "the window above ends before midnight" : "the grace above is 0, so nothing is given back"
          }
          tone="neutral"
        />
      ) : (
        <>
          <PreviewLine label={`The window above would reach`} result={nextDayClock(rule.reach)} tone="neutral" />
          <PreviewLine
            label={
              protection > 0
                ? `${protection} h before Tuesday's ${clock(shift.start)} start`
                : `0 hours: right up to Tuesday's ${clock(shift.start)} start`
            }
            result={rule.protectedFrom === null ? "-" : `nothing after ${nextDayClock(rule.protectedFrom)}`}
            tone="info"
          />
          <PreviewLine
            label="So punches are given back up to"
            result={`${nextDayClock(rule.cutoff)} (${rule.limitedBy === "protection" ? "the protection decides" : "the grace decides"})`}
            tone={rule.limitedBy === "protection" ? "warn" : "good"}
          />
        </>
      )}
    </PreviewCard>
  );

  return (
    <SettingsSection
      id="attendance-midnight"
      icon={MoonStar}
      title="Forgotten last punch after midnight"
      purpose="When someone forgets to punch out and the machine records the exit after midnight, that punch would otherwise become the next day's first punch. These two numbers decide when it is given back to the day before. Staff only."
      usedBy={[{ label: "Staff Attendance", to: "/hr/attendance/staff" }]}
      testId="attendance-midnight"
    >
      <SettingBlock
        id="forgotten-last-out"
        labelFor="forgotten-last-out-hours"
        title="Forgotten Last-Out Grace (hours after shift end)"
        purpose="A punch on the next morning, up to this many hours after the shift's end, is treated as the day before's last punch, but only when that day has no punch at or after its own shift end. 0 switches this off."
        affects={AFFECTS}
        defaultText="9 hours"
        note="Changing it re-judges past days too. A large value could take a genuine early arrival: the protection below prevents that."
        preview={preview}
      >
        <UnitInput
          id="forgotten-last-out-hours"
          value={draft.forgottenExitHours}
          onChange={(v) => patch({ forgottenExitHours: v })}
          unit="hours"
          step={0.5}
          min={0}
          max={24}
          disabled={!loaded}
          error={errors.forgottenExitHours}
        />
      </SettingBlock>

      <SettingBlock
        id="early-arrival-protection"
        labelFor="early-arrival-protection-hours"
        title="Next-Day Early-Arrival Protection (hours before shift start)"
        purpose="The window above always stops this many hours before the next day's own shift starts, so a genuinely early arrival is never given to the day before. 0 lets the window run right up to the next shift's start."
        affects={AFFECTS}
        defaultText="2 hours"
        note="Only matters while the grace above is more than 0."
        preview={protectionPreview}
      >
        <UnitInput
          id="early-arrival-protection-hours"
          value={draft.earlyArrivalProtectionHours}
          onChange={(v) => patch({ earlyArrivalProtectionHours: v })}
          unit="hours"
          step={0.5}
          min={0}
          max={24}
          disabled={!loaded}
          error={errors.earlyArrivalProtectionHours}
        />
      </SettingBlock>
    </SettingsSection>
  );
}
