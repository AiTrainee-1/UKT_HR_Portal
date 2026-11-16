import { useState } from "react";
import { Gift, IndianRupee } from "lucide-react";
import type { PayrollSettingsItem } from "@/lib/api-client/custom-hooks";
import { ManagedElsewhere, PreviewCard, PreviewLine, SettingBlock, SettingsSection } from "../kit/SettingBlock";
import { PRODUCTION_SECTIONS, productionText } from "../ProductionPayrollTab.meta";
import { numberOr, RANGES, type Draft, type NumberRule } from "../payroll/form";
import { bonusFor, formatPaise, formatPercent, formatRupees, MONTHS, productionPay } from "../payroll/preview";
import { bonusPercentWarning } from "../payroll/sections";
import { ConfirmChanges, NumberInput, StickySave, TextLink } from "../payroll/ui";
import { cn } from "@/lib/utils";
import { CYCLE_INFO } from "./cycles";
import { Tile } from "./CycleCard";
import { payBonusChanges, payBonusErrors, prodBonusReported, type PayBonusForm } from "./sections";

const block = (id: string) => ({ id, ...productionText(id) });

/** The form value each setting's card at the top shows. */
const keyOf: Record<string, keyof PayBonusForm> = {
  "default-salary-per-shift": "defaultSalaryPerShift",
  "prod-bonus-percent": "prodBonusPercent",
  "prod-bonus-wage-ceiling": "prodBonusWageCeiling",
  "prod-bonus-eligibility-ceiling": "prodBonusEligibilityCeiling",
};

/** A production worker's pay over a financial year on each cycle: the number of payslips and one payslip's pay. */
const YEAR = [
  { cycle: "weekly", payslips: 52, pay: 4_800 },
  { cycle: "biweekly", payslips: 26, pay: 9_600 },
  { cycle: "monthly", payslips: 13, pay: 19_200 },
] as const;

const slips = (n: number, pay: number) => Array.from({ length: n }, () => pay);

/**
 * Settings -> Production Payroll -> "Pay & Bonus": the Salary Per Shift suggested for a new production employee, and the
 * statutory bonus of production workers (rate, wage ceiling, eligibility limit), kept apart from the staff bonus on Staff
 * Payroll. The financial year start month is one company-wide value that stays on Staff Payroll. One Save for the sub-tab;
 * it sends only the values that were changed.
 */
export function PayBonusPanel({
  draft,
  saved,
  settings,
  readOnly,
  saving,
  busy,
  onSave,
}: {
  draft: Draft<PayBonusForm>;
  saved: PayBonusForm;
  settings: PayrollSettingsItem;
  readOnly: boolean;
  saving: boolean;
  /** Another save of this tab is running. */
  busy: boolean;
  onSave: () => Promise<void>;
}) {
  const { form, set } = draft;
  const errors = payBonusErrors(form, saved);
  const invalid = Object.keys(errors).length > 0;
  const reported = prodBonusReported(settings);
  const bonusLocked = readOnly || !reported;
  const warning = bonusPercentWarning(form.prodBonusPercent);
  const [confirming, setConfirming] = useState(false);
  const bonusChanged = draft.changed.some((k) => k !== "defaultSalaryPerShift");
  const changes = payBonusChanges(draft.changed, saved, form);

  const value = (key: keyof PayBonusForm, rule: NumberRule) => numberOr(form[key], rule, numberOr(saved[key], rule, 0));
  const perShift = value("defaultSalaryPerShift", RANGES.perShift);
  const percent = value("prodBonusPercent", RANGES.percent);
  const wageCeiling = value("prodBonusWageCeiling", RANGES.amount);
  const eligibility = value("prodBonusEligibilityCeiling", RANGES.amount);
  const rules = { wageCeiling, eligibilityCeiling: eligibility, percent };
  const verdict = (b: ReturnType<typeof bonusFor>) => (b.eligible ? `bonus ${formatPaise(b.amount)}` : "not eligible");
  const year = YEAR.map((y) => ({
    ...y,
    ...CYCLE_INFO[y.cycle],
    bonus: bonusFor({ ...rules, slipBasics: slips(y.payslips, y.pay) }),
  }));
  const fyStart = settings.bonusFyStartMonth ?? 4;

  const notReported = !reported && (
    <p data-testid="prod-bonus-not-reported" className="text-[11px] font-medium text-slate-500">
      Not reported by the server, so it cannot be changed here
    </p>
  );

  const biweekly = year[1];
  const tiles: { id: string; label: string; value: string; line: string; example: string }[] = [
    {
      id: "default-salary-per-shift",
      label: "Suggested rate per shift",
      value: perShift > 0 ? `${formatRupees(perShift)} a shift` : "No suggestion",
      line: "Pre-fills Salary Per Shift on Add Employee for a new production employee.",
      example:
        perShift > 0
          ? `26 shifts at ${formatRupees(perShift)} = ${formatPaise(productionPay({ ratePerShift: perShift, shifts: 26 }).gross)}`
          : "The box on Add Employee starts empty.",
    },
    {
      id: "prod-bonus-percent",
      label: "Production bonus rate",
      value: formatPercent(percent),
      line: "Of each eligible worker's bonus wage for the year.",
      example: `BiWeekly, ${biweekly.payslips} payslips of ${formatRupees(biweekly.pay)}: ${verdict(biweekly.bonus)}`,
    },
    {
      id: "prod-bonus-wage-ceiling",
      label: "Bonus wage ceiling",
      value: `${formatRupees(wageCeiling)} a payslip`,
      line: "Each payslip's pay counts towards the bonus wage up to this.",
      example: `A ${formatRupees(biweekly.pay)} payslip counts as ${formatRupees(Math.min(biweekly.pay, wageCeiling))}`,
    },
    {
      id: "prod-bonus-eligibility-ceiling",
      label: "Bonus eligibility limit",
      value: formatRupees(eligibility),
      line: "A worker whose latest payslip is above this gets no bonus.",
      example: `Latest payslip ${formatRupees(24_600)}: ${bonusFor({ ...rules, slipBasics: [24_600] }).eligible ? "eligible" : "not eligible"}`,
    },
  ];
  /** The look of a setting drawn as a card of its own. */
  const card = "rounded-xl border border-slate-200 bg-white p-4 first:border-t first:pt-4 sm:p-5 sm:first:pt-5";

  return (
    <div className="space-y-4" data-testid="production-pay-bonus">
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" data-testid="pay-bonus-glance">
        {tiles.map((t) => (
          <li key={t.id} className="flex min-w-0" data-testid={`pay-bonus-glance-${t.id}`}>
            <Tile
              label={t.label}
              value={t.value}
              tone={draft.changed.includes(keyOf[t.id]) ? "accent" : "plain"}
              sub={
                <>
                  <span className="block">{t.line}</span>
                  <span className="mt-1 block font-medium text-slate-700">Example: {t.example}</span>
                  <button
                    type="button"
                    data-view-safe
                    className="mt-1.5 inline-block font-semibold text-[#006496] hover:underline"
                    onClick={() =>
                      document.getElementById(t.id)?.scrollIntoView({ behavior: "smooth", block: "center" })
                    }
                  >
                    {readOnly ? "See it below" : "Change it below"}
                  </button>
                </>
              }
            />
          </li>
        ))}
      </ul>
      {draft.dirty && (
        <p
          className="inline-flex rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-800 ring-1 ring-amber-200"
          data-testid="pay-bonus-glance-unsaved"
        >
          The cards show your changes, which are not saved yet
        </p>
      )}

      <SettingsSection
        icon={IndianRupee}
        title={PRODUCTION_SECTIONS.pay}
        purpose="The Salary Per Shift suggested when a new production employee is added. Pay itself is worked out from each employee's own rate."
        usedBy={[{ label: "Add Employee", to: "/hr/employees/new" }]}
        testId="production-pay-section"
      >
        <SettingBlock
          {...block("default-salary-per-shift")}
          labelFor="default-salary-per-shift-input"
          defaultText="₹0 (no suggestion)"
          className={cn(card, "mt-3")}
          affects={[
            {
              where: "Add Employee",
              what: "pre-fills Salary Per Shift when Employment Type is Production and the box is still empty; existing employees keep their own rate.",
              to: "/hr/employees/new",
            },
          ]}
          preview={
            <PreviewCard scenario="Adding a new production employee.">
              <PreviewLine
                label="Salary Per Shift box"
                result={perShift > 0 ? `shows ${formatRupees(perShift)}` : "left empty (0 = no suggestion)"}
              />
              {perShift > 0 && (
                <PreviewLine
                  label="20.5 shifts at that rate, if it is kept"
                  result={formatPaise(productionPay({ ratePerShift: perShift, shifts: 20.5 }).gross)}
                />
              )}
            </PreviewCard>
          }
        >
          <NumberInput
            id="default-salary-per-shift-input"
            value={form.defaultSalaryPerShift}
            onChange={(v) => set("defaultSalaryPerShift", v)}
            prefix="₹"
            placeholder="e.g. 300"
            error={errors.defaultSalaryPerShift}
            hint="0 = no suggestion. Production pay itself is worked out from the shifts earned and each employee's own rate."
            disabled={readOnly}
          />
        </SettingBlock>
      </SettingsSection>

      <SettingsSection
        icon={Gift}
        title={PRODUCTION_SECTIONS.bonus}
        purpose="How the Bonus page works out each production worker's statutory bonus for a financial year (Payment of Bonus Act, 1965). Nothing is paid by itself: HR previews the figures and writes the bonus register with Generate on the Bonus page. Staff have their own values on Staff Payroll."
        usedBy={[{ label: "Bonus", to: "/hr/bonus" }, { label: "MD portal" }]}
        testId="production-bonus-section"
      >
        <p
          className="mt-3 rounded-xl bg-[#eff6fb] px-3.5 py-2.5 text-[13px] leading-snug text-slate-800 ring-1 ring-[#cfe2ee]"
          data-testid="prod-bonus-formula"
        >
          <strong>Bonus = bonus wage × {formatPercent(percent)}</strong>. The bonus wage adds up each payslip's pay of
          the year, counting at most {formatRupees(wageCeiling)} of any one payslip. Only workers whose latest payslip
          is at most {formatRupees(eligibility)} get a bonus.
        </p>
        <div className="mt-3 grid gap-3 2xl:grid-cols-3">
          <SettingBlock
            {...block("prod-bonus-percent")}
            labelFor="prod-bonus-percent-input"
            defaultText="8.33%"
            className={cn(card, "2xl:grid-cols-1")}
            affects={[
              {
                where: "Bonus",
                what: "bonus = the year's bonus wage x this rate, in the preview and when Generate writes the register (each row keeps the rate it was generated with; the Excel export and the MD portal read the register).",
                to: "/hr/bonus",
              },
            ]}
            note="Generating a year's bonus again updates its rows with the rate of that moment."
            preview={
              <PreviewCard
                scenario={`A production worker paid every period of the year, wage ceiling ${formatRupees(wageCeiling)} per payslip, eligibility limit ${formatRupees(eligibility)}, rate ${formatPercent(percent)}.`}
                testId="prod-bonus-percent-preview"
              >
                {year.slice(0, 2).map((y) => (
                  <PreviewLine
                    key={y.cycle}
                    label={`${y.label}: ${y.payslips} payslips of ${formatRupees(y.pay)}`}
                    result={verdict(y.bonus)}
                  />
                ))}
              </PreviewCard>
            }
          >
            <NumberInput
              id="prod-bonus-percent-input"
              value={form.prodBonusPercent}
              onChange={(v) => set("prodBonusPercent", v)}
              unit="%"
              error={errors.prodBonusPercent}
              hint="The Act allows 8.33 to 20. Up to 2 decimals."
              disabled={bonusLocked}
            />
            {warning && !errors.prodBonusPercent && (
              <p
                className="rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs font-medium text-amber-800"
                data-testid="prod-bonus-act-warning"
              >
                {warning}
              </p>
            )}
            {notReported}
          </SettingBlock>

          <SettingBlock
            {...block("prod-bonus-wage-ceiling")}
            labelFor="prod-bonus-wage-ceiling-input"
            defaultText="₹7,000"
            className={cn(card, "2xl:grid-cols-1")}
            affects={[
              {
                where: "Bonus",
                what: "a production worker's bonus wage = the sum, over the year's payslips, of the smaller of each payslip's pay and this ceiling.",
                to: "/hr/bonus",
              },
            ]}
            note="Applied per payslip: a production worker has about 52 payslips a year on the Weekly cycle, 26 on BiWeekly and 13 on Monthly, each capped separately, and a production payslip's Basic is its whole period pay."
            preview={
              <PreviewCard
                scenario={`Bonus rate ${formatPercent(percent)}, ceiling ${formatRupees(wageCeiling)} per payslip.`}
                testId="prod-bonus-wage-preview"
              >
                {year.map((y) => (
                  <PreviewLine
                    key={y.cycle}
                    label={`${y.label}, ${y.payslips} payslips of ${formatRupees(y.pay)}`}
                    result={`wage ${formatPaise(y.bonus.base)} - ${verdict(y.bonus)}`}
                  />
                ))}
              </PreviewCard>
            }
          >
            <NumberInput
              id="prod-bonus-wage-ceiling-input"
              value={form.prodBonusWageCeiling}
              onChange={(v) => set("prodBonusWageCeiling", v)}
              prefix="₹"
              unit="per payslip"
              error={errors.prodBonusWageCeiling}
              disabled={bonusLocked}
            />
            {notReported}
          </SettingBlock>

          <SettingBlock
            {...block("prod-bonus-eligibility-ceiling")}
            labelFor="prod-bonus-eligibility-ceiling-input"
            defaultText="₹21,000"
            className={cn(card, "2xl:grid-cols-1")}
            affects={[
              {
                where: "Bonus",
                what: 'production workers above it are listed with "Monthly wage ... exceeds the ... eligibility ceiling" and skipped by Generate.',
                to: "/hr/bonus",
              },
            ]}
            note="The latest payslip's whole period pay is compared with the limit."
            preview={
              <PreviewCard
                scenario={`Limit ${formatRupees(eligibility)} on the year's latest payslip.`}
                testId="prod-bonus-eligibility-preview"
              >
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
              id="prod-bonus-eligibility-ceiling-input"
              value={form.prodBonusEligibilityCeiling}
              onChange={(v) => set("prodBonusEligibilityCeiling", v)}
              prefix="₹"
              error={errors.prodBonusEligibilityCeiling}
              hint="At or below this latest payslip, a worker is eligible."
              disabled={bonusLocked}
            />
            {notReported}
          </SettingBlock>
        </div>
      </SettingsSection>

      <ManagedElsewhere
        title="Which months make up the bonus year"
        to="/hr/settings?tab=payroll#fy-start-month"
        linkLabel="Financial year start month"
        testId="prod-bonus-fy-pointer"
      >
        One company-wide value for staff and production alike, set on Staff Payroll, Payroll Rules (now{" "}
        {MONTHS[fyStart - 1] ?? fyStart}). The staff bonus is on{" "}
        <TextLink to="/hr/settings?tab=payroll#bonus-percent">Staff Payroll - Bonus</TextLink>.
      </ManagedElsewhere>

      <StickySave
        dirty={draft.dirty}
        saving={saving}
        onSave={() => (bonusChanged ? setConfirming(true) : void onSave())}
        onDiscard={draft.discard}
        saveLabel="Save Pay & Bonus settings"
        disabled={readOnly || invalid || busy || !draft.dirty}
        hint={invalid ? "Fix the values marked in red first." : undefined}
      />

      <ConfirmChanges
        open={confirming}
        onOpenChange={setConfirming}
        title="Save the new production bonus rules?"
        changes={changes}
        confirmLabel="Save changes"
        onConfirm={() => void onSave()}
      >
        <p>
          The Bonus page's figures for every production worker follow them at once. A bonus register already generated
          keeps its amounts until Generate is run again for that year, which rewrites every row with these values. Staff
          are not affected.
        </p>
        {warning && <p className="text-amber-700">{warning}</p>}
        {settings.companyWideRulesEditable === false && (
          <p>You are signed in to a branch: this applies to your branch's employees only.</p>
        )}
      </ConfirmChanges>
    </div>
  );
}
