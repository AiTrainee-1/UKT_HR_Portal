import { useState } from "react";
import { Gift } from "lucide-react";
import { ManagedElsewhere, PreviewCard, PreviewLine, SettingBlock, SettingsSection } from "../kit/SettingBlock";
import { PAYROLL_SECTIONS, payrollText } from "../PayrollTab.meta";
import { numberOr, RANGES, type Draft, type NumberRule } from "./form";
import { bonusFor, formatPaise, formatPercent, formatRupees, MONTHS, staffFullMonthBasic } from "./preview";
import { BONUS_LABELS, bonusErrors, bonusPercentWarning, describeChanges, hasErrors, type BonusForm } from "./sections";
import { ConfirmChanges, NumberInput, StickySave, TextLink } from "./ui";

const block = (id: string) => ({ id, ...payrollText(id) });
const months = (n: number, basic: number) => Array.from({ length: n }, () => basic);

/**
 * Settings -> Staff Payroll -> "Bonus": the statutory bonus rate and its two ceilings for STAFF (the Bonus page's engine).
 * Production workers have their own on Production Payroll, Pay & Bonus; the financial year start month is one company-wide
 * value shared by both.
 */
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
  const atLimit = staffFullMonthBasic(eligibility * 2);
  const overLimit = staffFullMonthBasic(eligibility * 2 + 2);

  return (
    <div className="space-y-4">
      <SettingsSection
        icon={Gift}
        title={PAYROLL_SECTIONS.bonus}
        purpose="How the Bonus page works out each staff member's statutory bonus for a financial year (Payment of Bonus Act, 1965). Production workers have their own rate and ceilings on Production Payroll. Nothing is paid by itself: HR previews the figures and writes the bonus register with Generate on the Bonus page."
        usedBy={[{ label: "Bonus", to: "/hr/bonus" }, { label: "MD portal" }]}
      >
        <SettingBlock
          {...block("bonus-percent")}
          labelFor="bonus-percent-input"
          defaultText="8.33%"
          affects={[
            {
              where: "Bonus",
              what: "a staff member's bonus = the year's bonus wage x this rate, in the preview and when Generate writes the register (each row keeps the rate it was generated with).",
              to: "/hr/bonus",
            },
            { where: "Bonus Excel export and the MD portal", what: "read the generated register, not this setting." },
          ]}
          note="Generating a year's bonus again updates its rows with the rate of that moment. Production workers are not affected: their rate is on Production Payroll."
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
              what: "a staff member's bonus wage = the sum, over the year's payslips, of the smaller of each payslip's Basic and this ceiling.",
              to: "/hr/bonus",
            },
          ]}
          note="Applied per payslip: a staff member has 12 monthly payslips a year, each capped separately. Production workers have more payslips and their own ceiling, on Production Payroll."
          preview={
            <PreviewCard scenario={`Bonus rate ${formatPercent(percent)}, ceiling ${formatRupees(wageCeiling)}.`}>
              <PreviewLine
                label="Staff, Basic ₹10,000 on each of 12 payslips"
                result={`wage ${formatPaise(staff20.base)} - ${verdict(staff20)}`}
              />
              <PreviewLine
                label="Staff, Basic ₹6,000 on each of 12 payslips"
                result={`wage ${formatPaise(staff12.base)} - ${verdict(staff12)}`}
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
          note={`For staff, Basic is half the salary, so a limit of ${formatRupees(eligibility)} covers salaries up to ${formatRupees(eligibility * 2)}. Production workers have a limit of their own, on Production Payroll.`}
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
        Set once for the company under Payroll Rules, Pay calendar (now {MONTHS[fyStartMonth - 1] ?? fyStartMonth}), for
        staff and production alike. It also sets the financial-year periods of payroll reports and the MD portal. The
        production bonus is on{" "}
        <TextLink to="/hr/settings?tab=production_payroll#prod-bonus-percent">
          Production Payroll - Pay &amp; Bonus
        </TextLink>
        .
      </ManagedElsewhere>

      <StickySave
        dirty={draft.dirty}
        saving={saving}
        onSave={() => (draft.dirty ? setConfirming(true) : void onSave())}
        onDiscard={draft.discard}
        saveLabel="Save Staff Bonus Settings"
        disabled={readOnly || invalid || busy}
        hint={invalid ? "Fix the values marked in red first." : undefined}
      />

      <ConfirmChanges
        open={confirming}
        onOpenChange={setConfirming}
        title="Save the new staff bonus rules?"
        changes={changes}
        confirmLabel="Save changes"
        onConfirm={() => void onSave()}
      >
        <p>
          The Bonus page's figures for every staff member follow them at once. A bonus register already generated keeps
          its amounts until Generate is run again for that year, which rewrites every row with these values. Production
          workers are not affected.
        </p>
        {warning && <p className="text-amber-700">{warning}</p>}
      </ConfirmChanges>
    </div>
  );
}
