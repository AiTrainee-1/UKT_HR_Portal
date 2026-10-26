import { useMemo } from "react";
import { CalendarDays } from "lucide-react";
import type { PayrollSettingsItem } from "@/lib/api-client/custom-hooks";
import { ManagedElsewhere, PreviewCard, PreviewLine, SettingBlock, SettingsSection } from "../kit/SettingBlock";
import { PAYROLL_SECTIONS, payrollText } from "../PayrollTab.meta";
import { numberOr, type Draft, type NumberRule } from "./form";
import { dayOf, formatDay, formatYearMonth, fyLabelFor, fyMonths, MONTHS, ordinal, payDayStatus } from "./preview";
import { FY_MONTH_RULE, hasErrors, ratesErrors, type RatesForm } from "./sections";
import { InfoBox, SelectInput, StickySave, TextLink } from "./ui";

const block = (id: string) => ({ id, ...payrollText(id) });

/**
 * Settings -> Staff Payroll -> "Payroll Rules": the pay calendar (salary pay day, financial year start month). Both are
 * company-wide values that apply to staff and production alike. PF and ESI have their own tab, PF & ESI; the rate
 * suggested for new production employees is on Production Payroll, Pay & Bonus.
 */
export function RatesPanel({
  draft,
  saved,
  settings,
  readOnly,
  saving,
  busy,
  onSave,
}: {
  draft: Draft<RatesForm>;
  saved: RatesForm;
  settings: PayrollSettingsItem | undefined;
  readOnly: boolean;
  saving: boolean;
  /** Another save of this tab is running. */
  busy: boolean;
  onSave: () => Promise<void>;
}) {
  const { form, set } = draft;
  const errors = ratesErrors(form, saved);
  const invalid = hasErrors(errors);
  const today = useMemo(() => dayOf(new Date()), []);
  const branchLogin = settings?.companyWideRulesEditable === false;

  // The typed value when it is valid, else the saved one: every example below is worked out from what is on screen.
  const value = (key: keyof RatesForm, rule: NumberRule) =>
    numberOr(String(form[key]), rule, numberOr(String(saved[key]), rule, 0));
  const payDay = value("payDay", { min: 0, max: 31, decimals: 0 });
  const fyStart = value("bonusFyStartMonth", FY_MONTH_RULE) || 4;

  // ── calendar examples ──
  const due = payDayStatus(payDay, today);
  const fyLabel = fyLabelFor(today.year, today.month, fyStart);
  const fy = fyMonths(fyLabel, fyStart);

  return (
    <div className="space-y-4">
      <ManagedElsewhere
        title="PF and ESI have their own tab"
        to="/hr/settings?tab=pf_esi"
        linkLabel="Open PF & ESI"
        testId="pf-esi-elsewhere"
      >
        The rules for Provident Fund and ESI, for staff and for production, with the salary ranges, the percentages and
        the units that have rules of their own, are on the PF & ESI tab. Nothing about them is set on this tab any more.
      </ManagedElsewhere>

      <InfoBox testId="compensation-split-note">
        <p>
          <strong>Compensation page (CTC Breakdown):</strong> nothing to set here any more. It shows each employee's own{" "}
          <strong>salary split</strong>, entered on Add / Edit Employee and Bulk Upload:
        </p>
        <ul className="list-disc space-y-0.5 pl-5">
          <li>
            <strong>First portion (50%)</strong> = Basic + DA + Retaining Allowance
          </li>
          <li>
            <strong>Second portion (50%)</strong> = Other Allowance + Petrol Allowance + HRA + Special Allowance + CA
          </li>
        </ul>
        <p>
          Its Employer PF and ESI follow the <TextLink to="/hr/settings?tab=pf_esi">PF &amp; ESI rules</TextLink>,
          applied to the first portion. The Basic % and HRA % boxes that used to be on this tab are no longer used.
          Payroll still takes Basic as 50% and HRA as 20% of the salary earned for the figures printed on a payslip; the
          recorded split decides who is eligible for PF and ESI and what they are calculated on.
        </p>
      </InfoBox>

      <SettingsSection
        icon={CalendarDays}
        title={PAYROLL_SECTIONS.calendar}
        purpose="Two company-wide calendar values: when salary is due and which months make up a financial year."
        usedBy={[
          { label: "MD portal" },
          { label: "Bonus", to: "/hr/bonus" },
          { label: "Report Center", to: "/hr/reports" },
        ]}
        testId="payroll-calendar-section"
      >
        <InfoBox testId="calendar-applies-to-everyone">
          <p>
            <strong>These two apply to everyone.</strong> The pay day and the financial year start month are one set of
            values: staff and production use the same ones, and nothing on Production Payroll sets them again. Set them
            from the company (admin) login: reports and the MD portal read the company value.
          </p>
        </InfoBox>

        <SettingBlock
          {...block("pay-day")}
          labelFor="pay-day-input"
          defaultText="5th"
          affects={[
            {
              where: "MD portal - Payroll",
              what: 'shows "Salary day is the 5th" and, once that day has passed, alerts when last month\'s payroll is not generated or not marked paid (critical after 7 more days).',
            },
            {
              where: "Payroll generation and payslips",
              what: "do not use it; production pay periods do not either.",
            },
          ]}
          note={
            branchLogin
              ? "The MD portal reads the company value: what a branch login saves here is shown back to that branch but not used there."
              : undefined
          }
          preview={
            <PreviewCard scenario={`Today is ${formatDay(today)}.`}>
              <PreviewLine label="The MD portal says" result={`Salary day is the ${ordinal(due.payDay)}`} />
              <PreviewLine
                label={`${MONTHS[due.salaryMonth.month - 1]} ${due.salaryMonth.year} salary is due on`}
                result={formatDay(due.due)}
              />
              <PreviewLine
                label="If it is not generated or not marked paid"
                result={
                  due.level === "not-due"
                    ? due.daysPast === 0
                      ? "due today - no alert yet"
                      : `no alert yet (due in ${-due.daysPast} days)`
                    : due.level === "warning"
                      ? `${due.daysPast} days past: a warning`
                      : `${due.daysPast} days past: a critical alert`
                }
                tone={due.level === "critical" ? "bad" : due.level === "warning" ? "warn" : "neutral"}
              />
            </PreviewCard>
          }
        >
          <SelectInput
            id="pay-day-input"
            value={form.payDay}
            onChange={(v) => set("payDay", v)}
            disabled={readOnly}
            className="max-w-[12rem]"
            options={[
              ...Array.from({ length: 28 }, (_, i) => ({
                value: String(i + 1),
                label: `${ordinal(i + 1)} of the month`,
              })),
              ...(Number(form.payDay) >= 1 && Number(form.payDay) <= 28
                ? []
                : [{ value: form.payDay, label: `${form.payDay} (used as the ${ordinal(due.payDay)})` }]),
            ]}
          />
          {errors.payDay && (
            <p role="alert" className="text-xs font-medium text-red-600">
              {errors.payDay}
            </p>
          )}
          <p className="text-xs text-gray-500">1st to 28th, so the day exists in every month.</p>
        </SettingBlock>

        <SettingBlock
          {...block("fy-start-month")}
          labelFor="fy-start-month-input"
          defaultText="April"
          affects={[
            {
              where: "Bonus",
              what: "which payslips count towards a year's bonus (staff and production alike), and which year the page opens on.",
              to: "/hr/bonus",
            },
            {
              where: "Report Center payroll reports",
              what: "the financial-year periods offered as filters.",
              to: "/hr/reports",
            },
            { where: "MD portal", what: 'the "This FY" period and the bonus summary.' },
            { where: "Finance and growth reports", what: "do not use it: they always start the year in April." },
          ]}
          note="Changing it re-cuts which payslips belong to a year. Bonus registers already generated keep their amounts until Generate is run again for that year, which recomputes them with the new months."
          preview={
            <PreviewCard scenario={`Today is ${formatDay(today)}.`}>
              <PreviewLine
                label="This financial year"
                result={`${fyLabel}: ${formatYearMonth(fy[0])} to ${formatYearMonth(fy[11])}`}
              />
              <PreviewLine label="The Bonus page opens on" result={`FY ${fyLabel}`} />
              {fyStart === 1 && (
                <PreviewLine
                  tone="warn"
                  label="Starting in January"
                  result={`still labelled "${fyLabel}" (start year, then the next year)`}
                />
              )}
            </PreviewCard>
          }
        >
          <SelectInput
            id="fy-start-month-input"
            value={form.bonusFyStartMonth}
            onChange={(v) => set("bonusFyStartMonth", v)}
            disabled={readOnly}
            className="max-w-[12rem]"
            options={[
              ...MONTHS.map((m, i) => ({ value: String(i + 1), label: m })),
              ...(Number(form.bonusFyStartMonth) >= 1 && Number(form.bonusFyStartMonth) <= 12
                ? []
                : [{ value: form.bonusFyStartMonth, label: `${form.bonusFyStartMonth} (not a month)` }]),
            ]}
          />
          {errors.bonusFyStartMonth && (
            <p role="alert" className="text-xs font-medium text-red-600">
              {errors.bonusFyStartMonth}
            </p>
          )}
        </SettingBlock>
      </SettingsSection>

      <StickySave
        dirty={draft.dirty}
        saving={saving}
        onSave={() => void onSave()}
        onDiscard={draft.discard}
        saveLabel="Save Payroll Settings"
        disabled={readOnly || invalid || busy}
        hint={invalid ? "Fix the values marked in red first." : undefined}
      />
    </div>
  );
}
