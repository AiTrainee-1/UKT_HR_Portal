import { useState } from "react";
import { Landmark } from "lucide-react";
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
import { PAYROLL_SECTIONS, payrollText } from "../PayrollTab.meta";
import { formatPaise, staffPay } from "./preview";

const block = (id: string) => ({ id, ...payrollText(id) });

/**
 * Settings -> Payroll -> "OT / Compensation": only the master switch of the OT & Compensation features. Every rule and every
 * feature switch (OT Detection types 1 and 2, Relaxation, Payment, Compensation Leave A, B and C) is on the Compensation tab.
 */
export function OtPanel({
  featuresOn,
  onFeatures,
  staffRates,
  branchLogin,
  readOnly,
}: {
  /** The master switch as it stands; it saves itself as soon as it is changed. */
  featuresOn: boolean;
  onFeatures: (enabled: boolean) => void;
  /** Staff PF / ESI as on the Payroll Rules sub-tab, for the take-home figures. */
  staffRates: { rulesOn: boolean; pfRate: number; esiRate: number; esiCeiling: number };
  branchLogin: boolean;
  readOnly: boolean;
}) {
  const [confirmFeaturesOff, setConfirmFeaturesOff] = useState(false);

  const month = { salary: 20_000, workingDays: 26, daysPaid: 26, otDays: 2, ...staffRates };
  const withOt = staffPay({ ...month, otOn: true });
  const withoutOt = staffPay({ ...month, otOn: false });

  return (
    <div className="space-y-4">
      <SettingsSection
        icon={Landmark}
        title={PAYROLL_SECTIONS.features}
        purpose="The Compensation page is mandatory: it always stays in the sidebar, and its records and reports can always be read. This switch only pauses or resumes what the features do in the background."
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
              what: "no new overtime is found and no next-day allowance is given while it is off.",
              to: "/hr/compensation",
            },
            {
              where: "Staff Payroll",
              what: "OT pay assigned as Payment is not added to payslips generated while it is off.",
              to: "/hr/payroll",
            },
            {
              where: "Staff Attendance",
              what: "announced late-in / early-out days, Compensation Days and birthday leave stop acting; attendance pages re-judge those days at once, past ones included.",
              to: "/hr/attendance/staff",
            },
            {
              where: "Compensation",
              what: "assigning OT, announcing, Sunday and holiday-work claims and redeeming the balance are refused; reading and reports still work.",
              to: "/hr/compensation",
            },
            { where: "Overtime and attendance reports", what: 'print a "switched off" note.', to: "/hr/reports" },
          ]}
          note={
            <>
              Saves as soon as you switch it (turning it off asks first). Nothing is deleted while it is off. Each
              feature also has its own switch on the Compensation tab.
              {branchLogin &&
                " OT detection and the Compensation page always read the company settings, so a change saved by a branch login does not reach them."}
            </>
          }
          preview={
            <PreviewCard scenario="A ₹20,000 staff salary, 26 working days all paid, 2 overtime days assigned as Payment (1 shift each), with the PF and ESI of the Payroll Rules sub-tab.">
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
          <p className="text-xs text-gray-500">The features on the Compensation tab only act while this is on.</p>
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
                  <li>OT is no longer detected and the next-day late-in allowance is not given.</li>
                  <li>OT assigned as Payment no longer adds pay to payslips generated from now on.</li>
                  <li>
                    Announced late-in / early-out days, Compensation Days and birthday leave stop acting on attendance
                    (attendance pages re-judge those days straight away, past ones included).
                  </li>
                  <li>
                    Assigning OT, announcing, Sunday and holiday-work claims and redeeming the balance are paused.
                  </li>
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

      <ManagedElsewhere
        title="Rules for OT, relaxation and payment are now in the Compensation tab"
        to="/hr/settings?tab=compensation"
        linkLabel="Open the Compensation tab"
        testId="ot-rules-moved"
      >
        The OT detection switch, the OT threshold and the company-wide Pay or Relaxation default that used to be here
        are replaced by the Compensation tab: Type 1 next-day allowance, Type 2 shift-based compensation with its
        threshold and time table, Relaxation, Payment, and Compensation Leave (announced late-in / early-out, work on
        Sundays and holidays, birthday). Their old values are kept but no longer used.
      </ManagedElsewhere>
    </div>
  );
}
