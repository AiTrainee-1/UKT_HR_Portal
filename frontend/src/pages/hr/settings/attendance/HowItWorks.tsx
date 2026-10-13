import { Coffee, Info, KeyRound, Sunrise } from "lucide-react";
import type { ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { arrivalLimits, clock, type ArrivalSettings } from "@/lib/arrival-rules";
import { ManagedElsewhere, SettingsSection } from "../kit/SettingBlock";
import { EXAMPLE_PAY_LINE, capitalise, describeShift, type ExampleShift } from "./example";
import { PERMISSION_MINUTES, lunchReturn } from "./preview";
import { SettingLink } from "./SettingLink";

export type Sample = { start: string; grace: number };

function Idea({
  icon,
  title,
  children,
  settings,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
  settings: ReactNode;
}) {
  return (
    <div className="settings-glass flex flex-col rounded-2xl p-3">
      <p className="flex items-center gap-1.5 text-[13px] font-bold text-gray-900">
        {icon} {title}
      </p>
      <p className="mt-1 flex-1 text-[12px] leading-relaxed text-gray-600">{children}</p>
      <p className="mt-2 text-[11px] leading-snug text-gray-500">{settings}</p>
    </div>
  );
}

/**
 * The top of the tab: how a staff day is judged, the three different "late" ideas side by side, and the example shift
 * every example on the tab is worked out for (HR can try their own start and grace; nothing here is saved).
 */
export function HowItWorks({
  sample,
  onSample,
  shift,
  arrival,
  arrivalValid,
  nightLateWindow,
  lunchZone,
  freeAllowance,
  permissionCap,
}: {
  sample: Sample;
  onSample: (s: Sample) => void;
  shift: ExampleShift | null;
  arrival: ArrivalSettings;
  arrivalValid: boolean;
  nightLateWindow: number;
  lunchZone: number;
  freeAllowance: number | null;
  permissionCap: number | null;
}) {
  const limits = shift && arrivalValid ? arrivalLimits(clock(shift.start), shift.grace, arrival) : null;
  const lunchOut = shift ? shift.lunchStart - 20 : 0;
  const lunch = shift
    ? lunchReturn(lunchOut, lunchOut + shift.lunchMinutes + 10, shift.lunchMinutes, nightLateWindow, lunchZone)
    : null;
  const t = (m: number | undefined) => (m === undefined ? "-" : clock(m));

  return (
    <SettingsSection
      id="attendance-how-it-works"
      icon={Info}
      title="How a staff day is judged"
      purpose="Each staff day is worked out from that person's punches and their own shift (start, end, grace and lunch come from Manage Shift). There are three different ideas of 'late' and only one of them costs money on its own."
      testId="attendance-how-it-works"
    >
      <div className="settings-clay-inset mt-3 p-3" data-testid="example-shift">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1 basis-60">
            <p className="text-[12px] font-bold text-blue-900">The example used on this tab</p>
            <p className="text-[12px] leading-snug text-blue-900/80">
              {shift
                ? `${capitalise(describeShift(shift))}, lunch ${clock(shift.lunchStart)}-${clock(shift.lunchStart + shift.lunchMinutes)}, ${EXAMPLE_PAY_LINE}.`
                : "Enter a valid shift start."}{" "}
              Change the start or the grace to try one of your shifts: nothing in this box is saved.
            </p>
          </div>
          <div className="space-y-1">
            <Label className="text-[11px]" htmlFor="arrival-sample-start">
              Shift start
            </Label>
            <Input
              id="arrival-sample-start"
              type="time"
              value={sample.start}
              onChange={(e) => onSample({ ...sample, start: e.target.value })}
              className="h-8 w-[110px] bg-white text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[11px]" htmlFor="arrival-sample-grace">
              Grace (min)
            </Label>
            <Input
              id="arrival-sample-grace"
              type="number"
              min={0}
              value={sample.grace}
              onChange={(e) => onSample({ ...sample, grace: Math.max(0, Number(e.target.value) || 0) })}
              className="h-8 w-[80px] bg-white text-xs"
            />
          </div>
        </div>
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-3" data-testid="three-late-ideas">
        <Idea
          icon={<Sunrise size={14} className="text-amber-500" />}
          title="Late in the morning"
          settings={
            <>
              Set below: Late window, Permission window, Extra minutes, Quarter-shift deduction and the Morning Late-In
              switch.
            </>
          }
        >
          {limits ? (
            <>
              A first punch after {t(limits.onTimeUntil)} and up to {t(limits.lateUntil)} is <b>Late</b>: still a Full
              Day, but one mark in the month's late pool
              {freeAllowance !== null ? ` (the first ${freeAllowance} marks a month are free)` : ""}. Later than that is
              not Late: it costs a quarter shift until {t(limits.firstHalfUntil)}, and after {t(limits.firstHalfUntil)}{" "}
              the morning half is missed.
            </>
          ) : (
            "Enter a valid example shift and valid numbers below to see the times."
          )}
        </Idea>
        <Idea
          icon={<Coffee size={14} className="text-emerald-600" />}
          title="Late back from lunch (Strict mode)"
          settings={<>Set below: Strict mode, Night Late window and Afternoon permission zone width.</>}
        >
          {shift && lunch ? (
            <>
              Someone who punches out for lunch at {t(lunchOut)} must be back by {t(lunch.deadline)} (the shift's{" "}
              {shift.lunchMinutes}-minute lunch). A later return is flagged <b>Late after lunch</b>. It is information
              only: it never changes pay, Full Day or Half Day, or the late pool.
            </>
          ) : (
            "Enter a valid example shift to see the times."
          )}
        </Idea>
        <Idea
          icon={<KeyRound size={14} className="text-violet-600" />}
          title="Permissions and the monthly cap"
          settings={
            <>
              The cap is on{" "}
              <SettingLink tab="late_detection" setting="permission-cap">
                Late Detection
              </SettingLink>
              ; the Permission window is set below.
            </>
          }
        >
          {limits ? (
            <>
              An approved Morning Late-In permission moves that day's start {PERMISSION_MINUTES} minutes later, so the
              example arrival is excused up to {t(limits.permissionUntil)}. Only the first{" "}
              {permissionCap !== null ? permissionCap : "few"} approved permissions in a month do this; each one after
              that excuses nothing and adds one mark to the late pool.
            </>
          ) : (
            "Enter a valid example shift and valid numbers below to see the times."
          )}
        </Idea>
      </div>

      <div className="mt-3">
        <ManagedElsewhere
          title="Shift times, grace and lunch are set per shift"
          to="/hr/shifts"
          linkLabel="Open Manage Shift"
          testId="attendance-shifts-elsewhere"
        >
          Each person's shift start and end, grace period, lunch start and lunch length come from their shift in Manage
          Shift. Nothing on this tab changes a shift; the rules here are measured from it.
        </ManagedElsewhere>
      </div>
    </SettingsSection>
  );
}
