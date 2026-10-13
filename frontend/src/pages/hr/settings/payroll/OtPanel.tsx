import { useState } from "react";
import { Clock, Landmark } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ManagedElsewhere, PreviewCard, PreviewLine, SettingBlock, SettingsSection } from "../kit/SettingBlock";
import { ToggleField } from "../kit/Field";
import { PAYROLL_SECTIONS, payrollText } from "../PayrollTab.meta";
import { numberOr, RANGES, type Draft } from "./form";
import { addMinutes, formatPaise, overtimeFor, staffPay } from "./preview";
import { hasErrors, otErrors, type OtForm } from "./sections";
import { NumberInput, StickySave } from "./ui";

const block = (id: string) => ({ id, ...payrollText(id) });

/** The shared example shift: 09:00-17:30. */
const SHIFT_END = "17:30";

/** Settings -> Payroll -> "OT / Compensation": the features' master switch and OT detection. */
export function OtPanel({
  draft,
  saved,
  featuresOn,
  onFeatures,
  staffRates,
  branchLogin,
  readOnly,
  saving,
  busy,
  onSave,
}: {
  draft: Draft<OtForm>;
  saved: OtForm;
  /** The master switch as it stands; it saves itself as soon as it is changed. */
  featuresOn: boolean;
  onFeatures: (enabled: boolean) => void;
  /** Staff PF / ESI as on the Payroll Rules sub-tab, for the take-home figures. */
  staffRates: { rulesOn: boolean; pfRate: number; esiRate: number; esiCeiling: number };
  branchLogin: boolean;
  readOnly: boolean;
  saving: boolean;
  busy: boolean;
  onSave: () => Promise<void>;
}) {
  const { form, set } = draft;
  const errors = otErrors(form, saved);
  const invalid = hasErrors(errors);
  const [confirmFeaturesOff, setConfirmFeaturesOff] = useState(false);

  const threshold = numberOr(form.otThresholdMinutes, { ...RANGES.otMinutes, min: 0 }, 60);
  const effective = threshold || 60;
  const month = { salary: 20_000, workingDays: 26, daysPaid: 26, otDays: 2, ...staffRates };
  const withOt = staffPay({ ...month, otOn: true });
  const withoutOt = staffPay({ ...month, otOn: false });
  // Minutes from 17:30 to midnight: overtime is measured on the same day's clock, so a punch after midnight never counts.
  const toMidnight = 390;
  const samples = [...new Set([Math.max(0, effective - 1), effective, 135])]
    .filter((m) => m < toMidnight)
    .sort((a, b) => a - b)
    .map((m) => addMinutes(SHIFT_END, m));

  return (
    <div className="space-y-4">
      <SettingsSection
        icon={Landmark}
        title={PAYROLL_SECTIONS.features}
        purpose="The Compensation page is mandatory: it always stays in the sidebar, and its records and reports can always be read. This switch only pauses or resumes what the feature does in the background."
        usedBy={[
          { label: "Compensation", to: "/hr/compensation" },
          { label: "Staff Payroll", to: "/hr/payroll" },
          { label: "Staff Attendance", to: "/hr/attendance/staff" },
        ]}
      >
        <SettingBlock
          {...block("compensation-features")}
          labelFor="compensation-features-switch"
          defaultText="On"
          affects={[
            {
              where: "Compensation - OT Detection",
              what: "no new overtime is found while it is off.",
              to: "/hr/compensation",
            },
            {
              where: "Staff Payroll",
              what: "announced OT pay is not added to payslips generated while it is off.",
              to: "/hr/payroll",
            },
            {
              where: "Staff Attendance",
              what: "Compensation Days stop excusing late and permission marks; attendance pages re-judge those days at once, past ones included.",
              to: "/hr/attendance/staff",
            },
            {
              where: "Compensation",
              what: "Announce, adding Compensation Days and redeeming credits are refused; reading and reports still work.",
              to: "/hr/compensation",
            },
            { where: "Overtime and attendance reports", what: 'print a "switched off" note.', to: "/hr/reports" },
          ]}
          note={
            <>
              Saves as soon as you switch it (turning it off asks first). Nothing is deleted while it is off.
              {branchLogin &&
                " OT detection and the Compensation page always read the company settings, so a change saved by a branch login does not reach them."}
            </>
          }
          preview={
            <PreviewCard scenario="A ₹20,000 staff salary, 26 working days all paid, 2 overtime days announced as Pay, with the PF and ESI of the Payroll Rules sub-tab.">
              <PreviewLine
                label={`Features on${featuresOn ? " (as set now)" : ""}`}
                result={`OT pay ${formatPaise(withOt.ot)} - take-home ${formatPaise(withOt.net)}`}
                tone={featuresOn ? "info" : "neutral"}
              />
              <PreviewLine
                label={`Features off${featuresOn ? "" : " (as set now)"}`}
                result={`no OT pay - take-home ${formatPaise(withoutOt.net)}; the 2 records are kept`}
                tone={featuresOn ? "neutral" : "info"}
              />
            </PreviewCard>
          }
        >
          <div className="flex items-center gap-3">
            <Switch
              id="compensation-features-switch"
              checked={featuresOn}
              aria-label="OT and Compensation features"
              data-testid="toggle-compensation-features"
              disabled={readOnly}
              onCheckedChange={(v) => (v ? onFeatures(true) : setConfirmFeaturesOff(true))}
            />
            <span className={`text-sm font-bold ${featuresOn ? "text-green-600" : "text-gray-400"}`}>
              {featuresOn ? "ON" : "OFF"}
            </span>
          </div>
          <p className="text-xs text-gray-500">The settings below only matter while this is on.</p>
        </SettingBlock>
      </SettingsSection>

      <AlertDialog open={confirmFeaturesOff} onOpenChange={setConfirmFeaturesOff}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Turn off the OT &amp; Compensation features?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>While they are off:</p>
                <ul className="list-disc space-y-1 pl-5">
                  <li>OT is no longer detected.</li>
                  <li>Announced OT no longer adds pay to payslips generated from now on.</li>
                  <li>
                    Compensation Days stop exempting Late / Permission detection (attendance pages re-judge those days
                    straight away, past ones included).
                  </li>
                  <li>Announcing OT, adding Compensation Days and redeeming credits are paused.</li>
                </ul>
                <p>
                  The <strong>Compensation page stays in the sidebar</strong> and all existing records are kept, not
                  deleted. You can turn this back on at any time.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep them on</AlertDialogCancel>
            <AlertDialogAction onClick={() => onFeatures(false)} data-testid="confirm-compensation-features-off">
              Turn off
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <SettingsSection
        icon={Clock}
        title={PAYROLL_SECTIONS.otDetection}
        purpose="Staff only. A flagged day is reviewed on Compensation -> OT Detection and announced as Pay (one day's salary on that month's payslip, at its next generation) or Relaxation (a paid Alternative Day credit to redeem later). Nothing is paid or credited until HR announces it."
        usedBy={[
          { label: "Compensation", to: "/hr/compensation" },
          { label: "Report Center", to: "/hr/reports" },
        ]}
      >
        <SettingBlock
          {...block("ot-detection")}
          labelFor="ot-detection-enabled"
          defaultText="Off"
          affects={[
            {
              where: "Compensation - OT Detection",
              what: 'flags days when someone opens the page for a month (not at payroll time); while off it lists only existing records, with an "OT detection is off" notice.',
              to: "/hr/compensation",
            },
            {
              where: "Staff Payroll",
              what: "pays only OT that HR announced as Pay, at the next generation of that month.",
              to: "/hr/payroll",
            },
            { where: "Timecard and overtime reports", what: "note when it is off.", to: "/hr/reports" },
          ]}
          note={
            featuresOn
              ? "Needs the OT & Compensation features above on as well."
              : "The OT & Compensation features above are off, so nothing is detected whatever this says."
          }
        >
          <ToggleField
            id="ot-detection-enabled"
            checked={form.otDetectionEnabled}
            onChange={(v) => set("otDetectionEnabled", v)}
            onLabel="On - late leavers are flagged for review"
            offLabel="Off - no new overtime is flagged"
            disabled={readOnly}
          />
        </SettingBlock>

        <SettingBlock
          {...block("ot-threshold")}
          labelFor="ot-threshold-input"
          defaultText="60 minutes"
          affects={[
            {
              where: "Compensation - OT Detection",
              what: "a day is flagged when the last punch is at least this many whole minutes after the employee's own shift end. Days already announced or rejected are never flagged again.",
              to: "/hr/compensation",
            },
            { where: "Report Center - Timecard", what: "shows OT minutes from the same threshold.", to: "/hr/reports" },
          ]}
          note="0 is no longer accepted: payroll treats 0 as 60 minutes."
          preview={
            <PreviewCard scenario={`A 09:00-${SHIFT_END} shift, threshold ${effective} minutes.`}>
              {samples.map((punch) => {
                const ot = overtimeFor(punch, SHIFT_END, threshold);
                return (
                  <PreviewLine
                    key={punch}
                    label={`Last punch ${punch} (${ot.minutes} min after the end)`}
                    result={ot.flagged ? "flagged as OT" : "not OT"}
                    tone={ot.flagged ? "good" : "neutral"}
                  />
                );
              })}
              {effective >= toMidnight && (
                <PreviewLine
                  tone="warn"
                  label={`${effective} minutes after ${SHIFT_END} is past midnight`}
                  result="a punch after midnight never counts as OT"
                />
              )}
              <PreviewLine
                label="Pay for one announced day (₹20,000 / 26 days)"
                result={`${formatPaise(withOt.dailyRate)}, however long the OT was`}
              />
            </PreviewCard>
          }
        >
          <NumberInput
            id="ot-threshold-input"
            value={form.otThresholdMinutes}
            onChange={(v) => set("otThresholdMinutes", v)}
            unit="minutes after the shift end"
            error={errors.otThresholdMinutes}
            hint="1 to 1440 (a whole day)."
            disabled={readOnly}
            className="w-28"
          />
        </SettingBlock>

        <div className="pt-2">
          <ManagedElsewhere
            title="Pay or Relaxation is chosen on each announcement"
            to="/hr/compensation"
            linkLabel="Open Compensation"
            testId="ot-type-pointer"
          >
            HR picks Pay or Relaxation every time with the Announce as Pay / Announce as Relaxation buttons, so the old
            "company-wide default" box is gone. The stored default is kept unchanged; it only applies to a program that
            announces OT without saying which.
          </ManagedElsewhere>
        </div>
      </SettingsSection>

      <StickySave
        dirty={draft.dirty}
        saving={saving}
        onSave={() => void onSave()}
        onDiscard={draft.discard}
        saveLabel="Save OT / Compensation Settings"
        disabled={readOnly || invalid || busy}
        hint={invalid ? "Fix the values marked in red first." : undefined}
      />
    </div>
  );
}
