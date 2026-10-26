import { Layers } from "lucide-react";
import { ManagedElsewhere, SettingsSection } from "../kit/SettingBlock";
import { SettingLink } from "../attendance/SettingLink";

const state = (on: boolean | undefined) =>
  on === undefined ? "not reported by the server" : on ? "counted" : "not counted (switched off)";

/**
 * What goes into the monthly late pool the Staff page prices. The two switches belong to the Attendance tab, so they are
 * plain links here; permissions beyond the cap are marks of the pool unless they are priced separately.
 */
export function PoolIntro({
  morningOn,
  eveningOn,
  pricingOn,
}: {
  morningOn: boolean | undefined;
  eveningOn: boolean | undefined;
  /** "Price permissions separately" is on (as typed): the permissions beyond the cap are not marks of this pool. */
  pricingOn: boolean;
}) {
  return (
    <SettingsSection
      id="late-pool-intro"
      icon={Layers}
      title="How the monthly late pool works"
      purpose="Staff page. Every calendar month each staff member's marks go into one pool: the first few are free, and the rest take part of a day's pay off their salary through the slabs below."
      testId="late-pool-intro"
    >
      <ul className="mt-3 space-y-1.5 text-[13px] text-gray-700" data-testid="late-detection-switch-status">
        <li>
          <b>Morning Late-In marks</b> (a first punch inside the Late window): {state(morningOn)}.{" "}
          <SettingLink tab="attendance" setting="morning-late-in" testId="link-morning-late-in">
            Change on the Attendance tab
          </SettingLink>
        </li>
        <li>
          <b>Evening Early-Out marks</b> (a last punch before the shift end minus grace): {state(eveningOn)}.{" "}
          <SettingLink tab="attendance" setting="evening-early-out" testId="link-evening-early-out">
            Change on the Attendance tab
          </SettingLink>
        </li>
        <li data-testid="late-pool-permissions">
          <b>Approved permissions beyond the monthly cap</b>:{" "}
          {pricingOn
            ? "not in this pool: they are priced on their own (Permission Pricing below), so nothing is deducted twice."
            : "one mark each (a Late day that has one counts once). The cap is in Permission Policy below; Permission Pricing can price them on their own instead."}
        </li>
      </ul>
      <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-[12px] leading-snug text-amber-900">
        Payslips already generated keep the deduction they were calculated with until that month's payroll is generated
        again. The Report Log, the employee shift statistics and the employee apps show the deduction under the current
        rules straight away, past months included, so they can differ from an old payslip until it is regenerated.
      </p>
      <div className="mt-3">
        <ManagedElsewhere
          title="Production workers have their own late rules"
          to="/hr/settings?tab=late_detection#prod-late-switch"
          linkLabel="Open the Production page"
          testId="late-production-elsewhere"
        >
          Nothing on this page applies to production workers. Their late deductions (per pay period, judged from the
          production shift rules) are on the Production page of this tab.
        </ManagedElsewhere>
      </div>
    </SettingsSection>
  );
}
