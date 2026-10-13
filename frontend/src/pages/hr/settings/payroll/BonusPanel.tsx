import { useState } from "react";
import { Gift } from "lucide-react";
import { ManagedElsewhere, PreviewCard, PreviewLine, SettingBlock, SettingsSection } from "../kit/SettingBlock";
import { PAYROLL_SECTIONS, payrollText } from "../PayrollTab.meta";
import { numberOr, RANGES, type Draft, type NumberRule } from "./form";
import { bonusFor, formatPaise, formatPercent, formatRupees, MONTHS, staffFullMonthBasic } from "./preview";
import { BONUS_LABELS, bonusErrors, bonusPercentWarning, describeChanges, hasErrors, type BonusForm } from "./sections";
import { ConfirmChanges, NumberInput, StickySave } from "./ui";

const block = (id: string) => ({ id, ...payrollText(id) });
const months = (n: number, basic: number) => Array.from({ length: n }, () => basic);

/** Settings -> Payroll -> "Bonus": the statutory bonus rate and its two ceilings (the Bonus page's engine). */
export function BonusPanel({
  draft,
  saved,
  fyStartMonth,
  readOnly,
  saving,
  busy,
  onSave,
}: {
  draft: Draft<BonusForm>;
  saved: BonusForm;
  /** The saved financial year start month (1-12), shown in the pointer to where it is set. */
  fyStartMonth: number;
  readOnly: boolean;
  saving: boolean;
  busy: boolean;
  onSave: () => Promise<void>;
}) {
  const { form, set } = draft;
  const errors = bonusErrors(form, saved);
  const invalid = hasErrors(errors);
  const warning = bonusPercentWarning(form.bonusPercent);
  const [confirming, setConfirming] = useState(false);
  const changes = describeChanges(draft.changed, saved, form, BONUS_LABELS);

  const value = (key: keyof BonusForm, rule: NumberRule) => numberOr(form[key], rule, numberOr(saved[key], rule, 0));
  const percent = value("bonusPercent", RANGES.percent);
  const wageCeiling = value("bonusWageCeiling", RANGES.amount);
  const eligibility = value("bonusEligibilityCeiling", RANGES.amount);
  const rules = { wageCeiling, eligibilityCeiling: eligibility, percent };

  const verdict = (b: ReturnType<typeof bonusFor>) => (b.eligible ? `bonus ${formatPaise(b.amount)}` : "not eligible");
  const staff20 = bonusFor({ ...rules, slipBasics: months(12, 10_000) });
  const staff12 = bonusFor({ ...rules, slipBasics: months(12, 6_000) });
  const production = bonusFor({ ...rules, slipBasics: months(26, 9_600) });
  const atLimit = staffFullMonthBasic(eligibility * 2);
  const overLimit = staffFullMonthBasic(eligibility * 2 + 2);

  return (
    <div className="space-y-4">
      <SettingsSection
        icon={Gift}
        title={PAYROLL_SECTIONS.bonus}
        purpose="How the Bonus page works out each employee's statutory bonus for a financial year (Payment of Bonus Act, 1965). Nothing is paid by itself: HR previews the figures and writes the bonus register with Generate on the Bonus page."
        usedBy={[{ label: "Bonus", to: "/hr/bonus" }, { label: "MD portal" }]}
      >
        <SettingBlock
          {...block("bonus-percent")}
          labelFor="bonus-percent-input"
          defaultText="8.33%"
          affects={[
            {
              where: "Bonus",
              what: "bonus = the year's bonus wage x this rate, in the preview and when Generate writes the register (each row keeps the rate it was generated with).",
              to: "/hr/bonus",
            },
            { where: "Bonus Excel export and the MD portal", what: "read the generated register, not this setting." },
          ]}
          note="Generating a year's bonus again updates its rows with the rate of that moment."
          preview={
            <PreviewCard
              scenario={`Staff paid every day of the year (12 payslips), wage ceiling ${formatRupees(wageCeiling)}, eligibility limit ${formatRupees(eligibility)}, rate ${formatPercent(percent)}.`}
            >
              <PreviewLine label="₹20,000 salary (Basic ₹10,000 a month)" result={verdict(staff20)} />
              <PreviewLine label="₹12,000 salary (Basic ₹6,000 a month)" result={verdict(staff12)} />
            </PreviewCard>
          }
        >
          <NumberInput
            id="bonus-percent-input"
            value={form.bonusPercent}
            onChange={(v) => set("bonusPercent", v)}
            unit="%"
            error={errors.bonusPercent}
            hint="The Act allows 8.33 to 20. Up to 2 decimals."
            disabled={readOnly}
          />
          {warning && !errors.bonusPercent && (
            <p
              className="rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs font-medium text-amber-800"
              data-testid="bonus-act-warning"
            >
              {warning}
            </p>
          )}
        </SettingBlock>

        <SettingBlock
          {...block("bonus-wage-ceiling")}
          labelFor="bonus-wage-ceiling-input"
          defaultText="₹7,000"
          affects={[
            {
              where: "Bonus",
              what: "bonus wage = the sum, over the year's payslips, of the smaller of each payslip's Basic and this ceiling.",
              to: "/hr/bonus",
            },
          ]}
          note="Applied per payslip: a production worker has about 52 payslips a year on the Weekly cycle, 26 on BiWeekly and 13 on Monthly, each capped separately, and a production payslip's Basic is its whole period pay."
          preview={
            <PreviewCard scenario={`Bonus rate ${formatPercent(percent)}, ceiling ${formatRupees(wageCeiling)}.`}>
              <PreviewLine
                label="Staff, Basic ₹10,000 on each of 12 payslips"
                result={`wage ${formatPaise(staff20.base)} - ${verdict(staff20)}`}
              />
              <PreviewLine
                label="Production, 26 BiWeekly payslips of ₹9,600"
                result={`wage ${formatPaise(production.base)} - ${verdict(production)}`}
              />
            </PreviewCard>
          }
        >
          <NumberInput
            id="bonus-wage-ceiling-input"
            value={form.bonusWageCeiling}
            onChange={(v) => set("bonusWageCeiling", v)}
            prefix="₹"
            unit="per payslip"
            error={errors.bonusWageCeiling}
            disabled={readOnly}
          />
        </SettingBlock>

        <SettingBlock
          {...block("bonus-eligibility-ceiling")}
          labelFor="bonus-eligibility-ceiling-input"
          defaultText="₹21,000"
          affects={[
            {
              where: "Bonus",
              what: 'employees above it are listed with "Monthly wage ... exceeds the ... eligibility ceiling" and skipped by Generate.',
              to: "/hr/bonus",
            },
          ]}
          note={`For staff, Basic is half the salary, so a limit of ${formatRupees(eligibility)} covers salaries up to ${formatRupees(eligibility * 2)}. For production, the latest payslip's whole period pay is compared.`}
          preview={
            <PreviewCard scenario={`Limit ${formatRupees(eligibility)} on the year's latest payslip Basic.`}>
              <PreviewLine
                label={`Staff, ${formatRupees(eligibility * 2)} salary (Basic ${formatRupees(atLimit)})`}
                result={bonusFor({ ...rules, slipBasics: [atLimit] }).eligible ? "eligible" : "not eligible"}
              />
              <PreviewLine
                label={`Staff, ${formatRupees(eligibility * 2 + 2)} salary (Basic ${formatRupees(overLimit)})`}
                result={bonusFor({ ...rules, slipBasics: [overLimit] }).eligible ? "eligible" : "not eligible"}
              />
              {[24_600, 9_600].map((pay) => (
                <PreviewLine
                  key={pay}
                  label={`Production, latest payslip ${formatRupees(pay)}`}
                  result={bonusFor({ ...rules, slipBasics: [pay] }).eligible ? "eligible" : "not eligible"}
                />
              ))}
            </PreviewCard>
          }
        >
          <NumberInput
            id="bonus-eligibility-ceiling-input"
            value={form.bonusEligibilityCeiling}
            onChange={(v) => set("bonusEligibilityCeiling", v)}
            prefix="₹"
            error={errors.bonusEligibilityCeiling}
            hint="At or below this latest Basic, an employee is eligible."
            disabled={readOnly}
          />
        </SettingBlock>
      </SettingsSection>

      <ManagedElsewhere
        title="Which months make up the bonus year"
        to="/hr/settings?tab=payroll#fy-start-month"
        linkLabel="Financial year start month"
        testId="bonus-fy-pointer"
      >
        Set once for the company under Payroll Rules, Pay calendar and defaults (now{" "}
        {MONTHS[fyStartMonth - 1] ?? fyStartMonth}
        ). It also sets the financial-year periods of payroll reports and the MD portal.
      </ManagedElsewhere>

      <StickySave
        dirty={draft.dirty}
        saving={saving}
        onSave={() => (draft.dirty ? setConfirming(true) : void onSave())}
        onDiscard={draft.discard}
        saveLabel="Save Bonus Settings"
        disabled={readOnly || invalid || busy}
        hint={invalid ? "Fix the values marked in red first." : undefined}
      />

      <ConfirmChanges
        open={confirming}
        onOpenChange={setConfirming}
        title="Save the new bonus rules?"
        changes={changes}
        confirmLabel="Save changes"
        onConfirm={() => void onSave()}
      >
        <p>
          The Bonus page's figures for every employee follow them at once. A bonus register already generated keeps its
          amounts until Generate is run again for that year, which rewrites every row with these values.
        </p>
        {warning && <p className="text-amber-700">{warning}</p>}
      </ConfirmChanges>
    </div>
  );
}
