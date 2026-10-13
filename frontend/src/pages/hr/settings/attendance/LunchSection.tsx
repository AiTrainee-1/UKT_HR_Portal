import { Coffee } from "lucide-react";
import { clock } from "@/lib/arrival-rules";
import { PreviewCard, PreviewLine, SettingBlock, SettingsSection } from "../kit/SettingBlock";
import type { ExampleShift } from "./example";
import { num, type StaffDraft, type StaffErrors } from "./form";
import { effectiveLunchZone, effectiveNightLateWindow, lunchReturn, type LunchVerdict } from "./preview";
import { UnitInput } from "./UnitInput";

const VERDICT: Record<LunchVerdict, { text: string; tone: "good" | "warn" | "info" }> = {
  on_time: { text: "on time, no flag", tone: "good" },
  night_late: { text: "Late after lunch (Night Late)", tone: "warn" },
  lunch_permission: { text: "Lunch-return permission", tone: "info" },
};

/** Strict mode's lunch-return check: two numbers that only decide which label a late return gets. */
export function LunchSection({
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
  const simple = draft.attendanceMode === "simple";
  const window = effectiveNightLateWindow(num(draft.nightLateWindow));
  const zone = effectiveLunchZone(num(draft.lunchPermissionZone));
  const lunchOut = shift ? shift.lunchStart - 20 : 0;
  const deadline = shift ? lunchOut + shift.lunchMinutes : 0;
  const returns = shift
    ? [
        deadline,
        deadline + Math.min(10, window),
        ...(zone > 0 ? [deadline + window + Math.ceil(zone / 2)] : []),
        deadline + window + zone + 10,
      ]
    : [];
  const zeroWindow = num(draft.nightLateWindow) === 0;

  // The bands a late return falls in, as clock times for the example lunch (the zone block's own preview).
  const bands = (
    <PreviewCard
      title="Example"
      scenario={shift ? `Due back from lunch at ${clock(deadline)} (out at ${clock(lunchOut)}).` : undefined}
      testId="lunch-zone-bands"
    >
      {shift && !errors.nightLateWindow && !errors.lunchPermissionZone ? (
        <>
          <PreviewLine
            label={`${clock(deadline + 1)} - ${clock(deadline + window)}`}
            result="Late after lunch (Night Late)"
            tone="warn"
          />
          {zone > 0 ? (
            <>
              <PreviewLine
                label={`${clock(deadline + window + 1)} - ${clock(deadline + window + zone)}`}
                result="Lunch-return permission"
                tone="info"
              />
              <PreviewLine
                label={`After ${clock(deadline + window + zone)}`}
                result="Late after lunch (Night Late) again"
                tone="warn"
              />
            </>
          ) : (
            <PreviewLine
              label={`After ${clock(deadline + window)}`}
              result="Late after lunch (Night Late): there is no permission band"
              tone="warn"
            />
          )}
          {simple && (
            <PreviewLine label="Simple mode is selected" result="nothing about lunch is recorded" tone="neutral" />
          )}
        </>
      ) : (
        <p className="text-[12px] text-gray-500">Enter valid numbers to see it.</p>
      )}
    </PreviewCard>
  );

  const preview = (
    <PreviewCard
      title="Example"
      scenario={
        shift
          ? `Out for lunch at ${clock(lunchOut)} on a shift with a ${shift.lunchMinutes}-minute lunch: due back at ${clock(deadline)}.`
          : undefined
      }
    >
      {shift && !errors.nightLateWindow && !errors.lunchPermissionZone ? (
        <>
          {returns.map((back, i) => {
            const r = lunchReturn(
              lunchOut,
              back,
              shift.lunchMinutes,
              num(draft.nightLateWindow),
              num(draft.lunchPermissionZone),
            );
            return (
              <PreviewLine
                key={i}
                label={`Back at ${clock(back)}${r.minutesOver > 0 ? ` (${r.minutesOver} min over)` : ""}`}
                result={VERDICT[r.verdict].text}
                tone={VERDICT[r.verdict].tone}
              />
            );
          })}
          {simple && (
            <PreviewLine label="Simple mode is selected" result="nothing about lunch is recorded" tone="neutral" />
          )}
        </>
      ) : (
        <p className="text-[12px] text-gray-500">Enter valid numbers to see it.</p>
      )}
    </PreviewCard>
  );

  return (
    <SettingsSection
      id="attendance-lunch"
      icon={Coffee}
      title="Late back from lunch (Strict mode only)"
      purpose={
        simple
          ? "Simple mode is selected, so these two numbers are kept but not used until Strict mode is chosen."
          : "In Strict mode a return from lunch later than the lunch-out punch plus the shift's lunch length is flagged. Information only: it never changes Full Day or Half Day, pay, or the late pool."
      }
      usedBy={[
        { label: "Staff Attendance", to: "/hr/attendance/staff" },
        { label: "Reports", to: "/hr/reports" },
      ]}
      testId="attendance-lunch"
    >
      <SettingBlock
        id="night-late-window"
        labelFor="night-late-window-minutes"
        title="Night Late Window (minutes past lunch deadline)"
        purpose="How many minutes after the lunch deadline a late return is labelled 'Late after lunch' (Night Late). Every late return is flagged in some way: this number and the next one only decide which label it gets."
        affects={[
          {
            where: "Staff Attendance",
            what: "the 'Late after lunch' badge and the reason 'Night Late: left .., returned .., deadline ..'",
            to: "/hr/attendance/staff",
          },
          { where: "Reports", what: "the 'Night late' column of the late analysis", to: "/hr/reports" },
        ]}
        defaultText="60 minutes"
        note={
          zeroWindow
            ? "0 behaves as 60: the attendance engine reads an empty window as 60 minutes."
            : "The lunch start and lunch length come from each shift in Manage Shift. A shift's own 'lunch grace' is not used by anything."
        }
        preview={preview}
      >
        <UnitInput
          id="night-late-window-minutes"
          value={draft.nightLateWindow}
          onChange={(v) => patch({ nightLateWindow: v })}
          unit={zeroWindow ? `minutes (used as ${window})` : "minutes"}
          step={5}
          min={0}
          max={240}
          disabled={!loaded}
          error={errors.nightLateWindow}
        />
      </SettingBlock>

      <SettingBlock
        id="lunch-permission-zone"
        labelFor="lunch-permission-zone-minutes"
        title="Afternoon Permission Zone Width (minutes)"
        purpose="A band straight after the Night Late window: a return in it is labelled 'Lunch-return permission' instead of Night Late. A return after the band is 'Late after lunch' again. 0 means there is no such band."
        affects={[
          { where: "Staff Attendance", what: "the 'Lunch-return permission' badge", to: "/hr/attendance/staff" },
          { where: "Older employee apps", what: "count these days as permission-zone days" },
        ]}
        defaultText="60 minutes"
        note="Not the same as the morning Permission window or the monthly permission cap: it excuses nothing."
        preview={bands}
      >
        <UnitInput
          id="lunch-permission-zone-minutes"
          value={draft.lunchPermissionZone}
          onChange={(v) => patch({ lunchPermissionZone: v })}
          unit="minutes"
          step={5}
          min={0}
          max={240}
          disabled={!loaded}
          error={errors.lunchPermissionZone}
        />
      </SettingBlock>
    </SettingsSection>
  );
}
