import { useMemo, useState } from "react";
import { CalendarDays, Factory, Landmark } from "lucide-react";
import type { PayrollSettingsItem } from "@/lib/api-client/custom-hooks";
import { ManagedElsewhere, PreviewCard, PreviewLine, SettingBlock, SettingsSection } from "../kit/SettingBlock";
import { ToggleField } from "../kit/Field";
import { PAYROLL_SECTIONS, payrollText } from "../PayrollTab.meta";
import { CYCLE_INFO, CYCLES } from "../production-payroll/cycles";
import { numberOr, RANGES, type Draft, type NumberRule } from "./form";
import {
  dayOf,
  formatDay,
  formatPaise,
  formatPercent,
  formatRupees,
  formatYearMonth,
  fyLabelFor,
  fyMonths,
  MONTHS,
  ordinal,
  payDayStatus,
  percentOf,
  productionPay,
  staffPay,
  toPaise,
} from "./preview";
import {
  describeChanges,
  FY_MONTH_RULE,
  hasErrors,
  RATES_LABELS,
  RATES_MONEY_KEYS,
  ratesErrors,
  type RatesForm,
} from "./sections";
import { ProductionPfOrder } from "./ProductionPfOrder";
import { ConfirmChanges, InfoBox, NumberInput, SelectInput, StickySave, TextLink } from "./ui";

const block = (id: string) => ({ id, ...payrollText(id) });

/** Said wherever the "estimated monthly pay" of a production payslip is named: it follows the pay cycle. */
const ESTIMATE_RULE = "period pay x 4 on Weekly, x 2 on BiWeekly, x 1 on Monthly";

/** Settings -> Payroll -> "Payroll Rules": staff PF/ESI, production flat PF/ESI, and the pay calendar defaults. */
export function RatesPanel({
  draft,
  saved,
  settings,
  bandsOn,
  bandCount,
  readOnly,
  saving,
  busy,
  onSave,
}: {
  draft: Draft<RatesForm>;
  saved: RatesForm;
  settings: PayrollSettingsItem | undefined;
  /** The Production PF/EF switch and band count as they stand (saved or being edited). */
  bandsOn: boolean;
  bandCount: number;
  readOnly: boolean;
  saving: boolean;
  /** Another save of this tab is running. */
  busy: boolean;
  onSave: () => Promise<void>;
}) {
  const { form, set } = draft;
  const errors = ratesErrors(form, saved);
  const invalid = hasErrors(errors);
  const [confirming, setConfirming] = useState(false);
  const today = useMemo(() => dayOf(new Date()), []);
  const branchLogin = settings?.companyWideRulesEditable === false;

  // The typed value when it is valid, else the saved one: every example below is worked out from what is on screen.
  const value = (key: keyof RatesForm, rule: NumberRule) =>
    numberOr(String(form[key]), rule, numberOr(String(saved[key]), rule, 0));
  const pfRate = value("pfRate", RANGES.percent);
  const esiRate = value("esiRate", RANGES.percent);
  const esiCeiling = value("esiApplicableBelow", RANGES.amount);
  const prodPfRate = value("prodPfRate", RANGES.percent);
  const prodEsiRate = value("prodEsiRate", RANGES.percent);
  const prodCeiling = value("prodEsiApplicableBelow", RANGES.amount);
  const payDay = value("payDay", { min: 0, max: 31, decimals: 0 });
  const fyStart = value("bonusFyStartMonth", FY_MONTH_RULE) || 4;
  const perShift = value("defaultSalaryPerShift", RANGES.perShift);

  // ── staff examples: ₹20,000 over 26 working days (the shared sample) ──
  const staff = { workingDays: 26, rulesOn: true, pfRate, esiRate, esiCeiling };
  const staffFull = staffPay({ ...staff, salary: 20_000, daysPaid: 26 });
  const staffPart = staffPay({ ...staff, salary: 20_000, daysPaid: 24 });
  const staffHigh = staffPay({ ...staff, salary: 30_000, daysPaid: 26 });
  const staffOff = staffPay({ ...staff, rulesOn: false, salary: 20_000, daysPaid: 26 });
  const ceilingSamples = [esiCeiling - 1_000, esiCeiling, esiCeiling + 1].filter((s) => s > 0);

  // ── production examples: ₹600 a shift ──
  const prod = {
    ratePerShift: 600,
    flatOn: true,
    pfRate: prodPfRate,
    esiRate: prodEsiRate,
    esiCeiling: prodCeiling,
    bandsOn: false,
    bands: [],
  };
  const prod16 = productionPay({ ...prod, shifts: 16 });
  const prod205 = productionPay({ ...prod, shifts: 20.5 });
  const prodOff = productionPay({ ...prod, flatOn: false, shifts: 16 });
  // The ESI estimate follows the pay cycle (period pay x 4 / x 2 / x 1): the same worker, six shifts a week, on each cycle.
  const cycleSamples = CYCLES.map((cycle) => {
    const { label, weeks, monthlyFactor } = CYCLE_INFO[cycle];
    const shifts = 6 * weeks;
    return { cycle, label, shifts, pay: productionPay({ ...prod, shifts, monthlyFactor }) };
  });
  // Period pays that land exactly on the ceiling and ₹100 above it, on each cycle.
  const prodCeilingSamples = CYCLES.flatMap((cycle) => {
    const { label, monthlyFactor } = CYCLE_INFO[cycle];
    return [prodCeiling / monthlyFactor, prodCeiling / monthlyFactor + 100]
      .filter((periodPay) => periodPay > 0)
      .map((periodPay) => ({
        cycle,
        label,
        periodPay,
        pay: productionPay({ ...prod, shifts: 1, ratePerShift: periodPay, monthlyFactor }),
      }));
  });

  // ── calendar examples ──
  const due = payDayStatus(payDay, today);
  const fyLabel = fyLabelFor(today.year, today.month, fyStart);
  const fy = fyMonths(fyLabel, fyStart);

  const changes = describeChanges(draft.changed, saved, form, RATES_LABELS);
  const movesMoney = draft.changed.some((k) => RATES_MONEY_KEYS.includes(k));
  const save = () => (movesMoney ? setConfirming(true) : void onSave());

  const on = (now: boolean) => (now ? " (as set now)" : "");

  return (
    <div className="space-y-4">
      <SettingsSection
        icon={Landmark}
        title={PAYROLL_SECTIONS.staff}
        purpose="What is deducted from staff (monthly salary) payslips for Provident Fund and ESI. Read when staff payroll is generated: payslips already generated keep their amounts until their month is generated again."
        usedBy={[
          { label: "Staff Payroll", to: "/hr/payroll" },
          { label: "Compensation (CTC)", to: "/hr/compensation" },
          { label: "Report Center", to: "/hr/reports" },
        ]}
      >
        <SettingBlock
          {...block("staff-pf-esi-switch")}
          labelFor="staff-pf-esi-enabled"
          defaultText="Off"
          affects={[
            {
              where: "Staff Payroll",
              what: "Off: PF and ESI are 0.00 on every staff payslip generated from now on. On: the three values below are deducted.",
              to: "/hr/payroll",
            },
            { where: "PF/ESI Coverage Register", what: "notes whether this switch was on.", to: "/hr/reports" },
            {
              where: "Compensation - CTC Breakdown",
              what: "ignores the switch: its Employer PF and ESI always follow the rates below.",
              to: "/hr/compensation",
            },
          ]}
          note="Off by default: a new installation pays staff with no PF or ESI until it is switched on. Payslips already generated keep their amounts; generating a month again re-prices it with the settings of that moment."
          preview={
            <PreviewCard
              scenario={`A ₹20,000 monthly salary with all 26 working days paid, at the rates below (PF ${formatPercent(pfRate)}, ESI ${formatPercent(esiRate)}).`}
            >
              <PreviewLine
                label={`Switch on${on(form.staffRulesEnabled)}`}
                result={`${formatPaise(staffFull.deductions)} deducted - take-home ${formatPaise(staffFull.net)}`}
                tone={form.staffRulesEnabled ? "info" : "neutral"}
              />
              <PreviewLine
                label={`Switch off${on(!form.staffRulesEnabled)}`}
                result={`nothing deducted - take-home ${formatPaise(staffOff.net)}`}
                tone={form.staffRulesEnabled ? "neutral" : "info"}
              />
            </PreviewCard>
          }
        >
          <ToggleField
            id="staff-pf-esi-enabled"
            checked={form.staffRulesEnabled}
            onChange={(v) => set("staffRulesEnabled", v)}
            onLabel="On - staff payslips deduct PF and ESI"
            offLabel="Off - no PF or ESI on staff payslips"
            disabled={readOnly}
          />
        </SettingBlock>

        <SettingBlock
          {...block("staff-pf-rate")}
          labelFor="staff-pf-rate-input"
          defaultText="0% (no PF)"
          affects={[
            {
              where: "Staff Payroll",
              what: 'PF = Basic x this rate on each payslip (shown as "PF (12%)"). There is no PF wage ceiling: all of the Basic counts at any salary.',
              to: "/hr/payroll",
            },
            {
              where: "Compensation - CTC Breakdown",
              what: "shows Employer PF = this rate x the employee's first salary portion.",
              to: "/hr/compensation",
            },
            {
              where: "Report Center employer cost and the MD portal",
              what: "do not read it: they assume 12% for the employer's PF.",
            },
          ]}
          preview={
            <PreviewCard
              scenario={`Staff PF at ${formatPercent(pfRate)}. Basic is half of the pay earned in the month (26 working days).`}
            >
              <PreviewLine
                label={`₹20,000 salary, all 26 days - Basic ${formatPaise(staffFull.basic)}`}
                result={`PF ${formatPaise(staffFull.pf)}`}
              />
              <PreviewLine
                label={`₹20,000 salary, 24 of 26 days - Basic ${formatPaise(staffPart.basic)}`}
                result={`PF ${formatPaise(staffPart.pf)}`}
              />
              <PreviewLine
                label={`₹30,000 salary, all 26 days - Basic ${formatPaise(staffHigh.basic)}`}
                result={`PF ${formatPaise(staffHigh.pf)}`}
              />
              {!form.staffRulesEnabled && (
                <PreviewLine tone="warn" label="The switch above is off" result="real payslips deduct nothing" />
              )}
            </PreviewCard>
          }
        >
          <NumberInput
            id="staff-pf-rate-input"
            value={form.pfRate}
            onChange={(v) => set("pfRate", v)}
            unit="%"
            placeholder="e.g. 12"
            error={errors.pfRate}
            hint="0 = no PF. Up to 2 decimals."
            disabled={readOnly}
          />
        </SettingBlock>

        <SettingBlock
          {...block("staff-esi-rate")}
          labelFor="staff-esi-rate-input"
          defaultText="0% (no ESI)"
          affects={[
            {
              where: "Staff Payroll",
              what: "ESI = pay earned in the month (OT pay not included) x this rate, when the full monthly salary is at or below the ceiling.",
              to: "/hr/payroll",
            },
            {
              where: "Compensation - CTC Breakdown",
              what: "uses the same rate for its Employer ESI line (Report Center and the MD portal assume 3.25% instead).",
              to: "/hr/compensation",
            },
          ]}
          preview={
            <PreviewCard
              scenario={`Staff ESI at ${formatPercent(esiRate)}, ceiling ${formatRupees(esiCeiling)}, 26 working days.`}
            >
              {[
                { label: `₹20,000 salary, all 26 days - pay ${formatPaise(staffFull.gross)}`, pay: staffFull },
                { label: `₹20,000 salary, 24 of 26 days - pay ${formatPaise(staffPart.gross)}`, pay: staffPart },
                { label: "₹30,000 salary, all 26 days", pay: staffHigh },
              ].map(({ label, pay }) => (
                <PreviewLine
                  key={label}
                  label={label}
                  result={
                    pay.esiApplies
                      ? `ESI ${formatPaise(pay.esi)}`
                      : esiRate > 0
                        ? "no ESI - above the ceiling"
                        : "no ESI"
                  }
                />
              ))}
              {!form.staffRulesEnabled && (
                <PreviewLine tone="warn" label="The switch above is off" result="real payslips deduct nothing" />
              )}
            </PreviewCard>
          }
        >
          <NumberInput
            id="staff-esi-rate-input"
            value={form.esiRate}
            onChange={(v) => set("esiRate", v)}
            unit="%"
            placeholder="e.g. 0.75"
            error={errors.esiRate}
            hint="0 = no ESI. Up to 2 decimals."
            disabled={readOnly}
          />
        </SettingBlock>

        <SettingBlock
          {...block("staff-esi-ceiling")}
          labelFor="staff-esi-ceiling-input"
          defaultText="₹21,000"
          affects={[
            {
              where: "Staff Payroll",
              what: "ESI is deducted only when the full monthly salary (not the pro-rated pay) is at or below it.",
              to: "/hr/payroll",
            },
            {
              where: "PF/ESI Coverage Register",
              what: "prints the ceiling each payslip was generated with.",
              to: "/hr/reports",
            },
            {
              where: "Employees Master report",
              what: "flags staff above it as not needing an ESI number.",
              to: "/hr/reports",
            },
            {
              where: "Compensation - CTC Breakdown",
              what: "shows Employer ESI only at or below it.",
              to: "/hr/compensation",
            },
          ]}
          note="Raising it starts ESI for staff who had none, from the next payroll generated."
          preview={
            <PreviewCard scenario={`A full month at the staff ESI rate above (${formatPercent(esiRate)}).`}>
              {ceilingSamples.map((salary) => {
                const pay = staffPay({ ...staff, salary, daysPaid: 26 });
                return (
                  <PreviewLine
                    key={salary}
                    label={`${formatRupees(salary)} salary${salary === esiCeiling ? " (equal to the ceiling)" : ""}`}
                    result={pay.esiApplies ? `pays ESI ${formatPaise(pay.esi)}` : "no ESI"}
                    tone={pay.esiApplies ? "good" : "neutral"}
                  />
                );
              })}
              {esiRate === 0 && <PreviewLine tone="warn" label="The ESI rate is 0%" result="nobody pays ESI" />}
            </PreviewCard>
          }
        >
          <NumberInput
            id="staff-esi-ceiling-input"
            value={form.esiApplicableBelow}
            onChange={(v) => set("esiApplicableBelow", v)}
            prefix="₹"
            error={errors.esiApplicableBelow}
            hint="At or below this monthly salary, ESI applies."
            disabled={readOnly}
          />
        </SettingBlock>

        <InfoBox testId="compensation-split-note" className="mt-2">
          <p>
            <strong>Compensation page (CTC Breakdown):</strong> nothing to set here any more. It shows each employee's
            own <strong>salary split</strong>, entered on Add / Edit Employee and Bulk Upload:
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
            Its Employer PF is the staff PF rate above applied to the first portion. The Basic % and HRA % boxes that
            used to be on this tab are no longer used. The split does not change payslips: payroll always takes Basic as
            50% and HRA as 20% of the salary earned.
          </p>
        </InfoBox>
      </SettingsSection>

      <SettingsSection
        icon={Factory}
        title={PAYROLL_SECTIONS.production}
        purpose="The simple way to take PF and ESI from production (per-shift) workers: one rate each for everyone. Salary bands on the Production PF/EF sub-tab can replace them for some or all workers."
        usedBy={[
          { label: "Production Payroll", to: "/hr/production-payroll" },
          { label: "Compensation (CTC)", to: "/hr/compensation" },
        ]}
      >
        <InfoBox className="my-2">
          <p className="font-semibold">How each production payslip's PF and ESI is decided</p>
          <ProductionPfOrder
            bandsOn={bandsOn}
            bandCount={bandCount}
            flatOn={form.prodRulesEnabled}
            pfRate={prodPfRate}
            esiRate={prodEsiRate}
          />
        </InfoBox>
        <div className="my-2">
          <ManagedElsewhere
            title="Production pay itself is not set here"
            to="/hr/settings?tab=production_payroll#prod-shifts-earned"
            linkLabel="Open Production Payroll settings"
            testId="production-pay-elsewhere"
          >
            The shifts a production day earns come from the production shift rules on the Production Shifts tab, and pay
            is shifts earned x each worker's own Salary Per Shift. The Production Payroll tab shows the whole chain, the
            pay period and the late deductions.
          </ManagedElsewhere>
        </div>

        <SettingBlock
          {...block("prod-pf-esi-switch")}
          labelFor="prod-pf-esi-enabled"
          defaultText="Off"
          affects={[
            {
              where: "Production Payroll",
              what: "used only for a worker no salary band matched: On deducts the flat rates below, Off deducts nothing.",
              to: "/hr/production-payroll",
            },
            { where: "PF/ESI Coverage Register", what: "notes whether this switch was on.", to: "/hr/reports" },
            {
              where: "Compensation - CTC Breakdown",
              what: "ignores the switch: Employer PF and ESI for production employees follow the rates below.",
              to: "/hr/compensation",
            },
          ]}
          note={
            bandsOn
              ? "Salary bands are on: a worker whose estimated monthly pay falls in a band pays that band's rates, whatever this switch says."
              : "Off by default."
          }
          preview={
            <PreviewCard scenario="16 shifts x ₹600 = ₹9,600 in the pay period, with no salary band matching.">
              <PreviewLine
                label={`Switch on${on(form.prodRulesEnabled)}`}
                result={`PF ${formatPaise(prod16.pf)} + ESI ${formatPaise(prod16.esi)} - take-home ${formatPaise(prod16.net)}`}
                tone={form.prodRulesEnabled ? "info" : "neutral"}
              />
              <PreviewLine
                label={`Switch off${on(!form.prodRulesEnabled)}`}
                result={`no PF or ESI - take-home ${formatPaise(prodOff.net)}`}
                tone={form.prodRulesEnabled ? "neutral" : "info"}
              />
            </PreviewCard>
          }
        >
          <ToggleField
            id="prod-pf-esi-enabled"
            checked={form.prodRulesEnabled}
            onChange={(v) => set("prodRulesEnabled", v)}
            onLabel="On - production payslips deduct the flat rates"
            offLabel="Off - no flat-rate PF or ESI on production payslips"
            disabled={readOnly}
          />
        </SettingBlock>

        <SettingBlock
          {...block("prod-pf-rate")}
          labelFor="prod-pf-rate-input"
          defaultText="0% (no PF)"
          affects={[
            {
              where: "Production Payroll",
              what: 'PF = period pay x this rate (shown as "PF (12%)"), when no band matched and the switch is on.',
              to: "/hr/production-payroll",
            },
            {
              where: "Compensation - CTC Breakdown",
              what: "Employer PF for production employees = this rate x their first salary portion.",
              to: "/hr/compensation",
            },
          ]}
          preview={
            <PreviewCard
              scenario={`Production PF at ${formatPercent(prodPfRate)} of the whole period pay, ₹600 a shift.`}
            >
              <PreviewLine label={`16 shifts = ${formatPaise(prod16.gross)}`} result={`PF ${formatPaise(prod16.pf)}`} />
              <PreviewLine
                label={`20.5 shifts = ${formatPaise(prod205.gross)}`}
                result={`PF ${formatPaise(prod205.pf)}`}
              />
              <PreviewLine
                label="Same rate on a ₹12,300 staff salary"
                result={`PF ${formatPaise(percentOf(toPaise(6_150), prodPfRate))} (staff PF is on half the pay)`}
              />
            </PreviewCard>
          }
        >
          <NumberInput
            id="prod-pf-rate-input"
            value={form.prodPfRate}
            onChange={(v) => set("prodPfRate", v)}
            unit="%"
            placeholder="e.g. 12"
            error={errors.prodPfRate}
            hint="0 = no PF. Up to 2 decimals."
            disabled={readOnly}
          />
        </SettingBlock>

        <SettingBlock
          {...block("prod-esi-rate")}
          labelFor="prod-esi-rate-input"
          defaultText="0% (no ESI)"
          affects={[
            {
              where: "Production Payroll",
              what: `ESI = period pay x this rate, when the estimated monthly pay (${ESTIMATE_RULE}) is at or below the production ESI ceiling.`,
              to: "/hr/production-payroll",
            },
            {
              where: "Compensation - CTC Breakdown",
              what: "Employer ESI for production employees.",
              to: "/hr/compensation",
            },
          ]}
          preview={
            <PreviewCard
              scenario={`Production ESI at ${formatPercent(prodEsiRate)}, ceiling ${formatRupees(prodCeiling)} on the estimated monthly pay; ₹600 a shift, six shifts a week.`}
            >
              {cycleSamples.map(({ cycle, label, shifts, pay: p }) => (
                <PreviewLine
                  key={cycle}
                  label={`${label}: ${shifts} shifts = ${formatPaise(p.gross)} (estimate ${formatPaise(p.monthlyEstimate)})`}
                  result={
                    p.esi > 0
                      ? `ESI ${formatPaise(p.esi)}`
                      : prodEsiRate > 0 && p.monthlyEstimate > toPaise(prodCeiling)
                        ? "no ESI - estimate above the ceiling"
                        : "no ESI"
                  }
                />
              ))}
            </PreviewCard>
          }
        >
          <NumberInput
            id="prod-esi-rate-input"
            value={form.prodEsiRate}
            onChange={(v) => set("prodEsiRate", v)}
            unit="%"
            placeholder="e.g. 0.75"
            error={errors.prodEsiRate}
            hint="0 = no ESI. Up to 2 decimals."
            disabled={readOnly}
          />
        </SettingBlock>

        <SettingBlock
          {...block("prod-esi-ceiling")}
          labelFor="prod-esi-ceiling-input"
          defaultText="₹21,000"
          affects={[
            {
              where: "Production Payroll",
              what: `compares the estimated monthly pay (${ESTIMATE_RULE}) with it; the payslip breakdown records both.`,
              to: "/hr/production-payroll",
            },
            {
              where: "PF/ESI Coverage Register",
              what: "lists workers within 10% below it as near the ceiling.",
              to: "/hr/reports",
            },
            {
              where: "Compensation - CTC Breakdown",
              what: "shows Employer ESI for production employees only at or below it.",
              to: "/hr/compensation",
            },
          ]}
          note="The estimate follows the pay cycle, so a worker is tested against the ceiling on what they earn in a month whichever cycle they are on: a Weekly payslip is multiplied by 4, a BiWeekly one by 2 and a Monthly (four-week) one by 1."
          preview={
            <PreviewCard
              scenario={`Production ESI at ${formatPercent(prodEsiRate)}; the estimate is the period pay x 4 (Weekly), x 2 (BiWeekly) or x 1 (Monthly).`}
            >
              {prodCeilingSamples.map(({ cycle, label, periodPay, pay: p }) => (
                <PreviewLine
                  key={`${cycle}-${periodPay}`}
                  label={`${label}: period pay ${formatRupees(periodPay)} - estimate ${formatPaise(p.monthlyEstimate)}${p.monthlyEstimate === toPaise(prodCeiling) ? " (equal)" : ""}`}
                  result={p.esi > 0 ? `pays ESI ${formatPaise(p.esi)}` : "no ESI"}
                  tone={p.esi > 0 ? "good" : "neutral"}
                />
              ))}
            </PreviewCard>
          }
        >
          <NumberInput
            id="prod-esi-ceiling-input"
            value={form.prodEsiApplicableBelow}
            onChange={(v) => set("prodEsiApplicableBelow", v)}
            prefix="₹"
            error={errors.prodEsiApplicableBelow}
            hint="At or below this estimated monthly pay, ESI applies."
            disabled={readOnly}
          />
        </SettingBlock>
      </SettingsSection>

      <SettingsSection
        icon={CalendarDays}
        title={PAYROLL_SECTIONS.calendar}
        purpose="Three company-wide defaults: when salary is due, which months make up a financial year, and the rate per shift suggested for new production employees."
        usedBy={[
          { label: "MD portal" },
          { label: "Bonus", to: "/hr/bonus" },
          { label: "Report Center", to: "/hr/reports" },
          { label: "Add Employee", to: "/hr/employees/new" },
        ]}
      >
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
              what: "which 12 monthly payslips count towards a year's bonus, and which year the page opens on.",
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

        <SettingBlock
          {...block("default-salary-per-shift")}
          labelFor="default-salary-per-shift-input"
          defaultText="₹0 (no suggestion)"
          affects={[
            {
              where: "Add Employee",
              what: "pre-fills Salary Per Shift when Employment Type is Production and the box is still empty.",
              to: "/hr/employees/new",
            },
            {
              where: "Edit Employee, Bulk Upload and payroll",
              what: "do not use it; existing employees keep their own rate.",
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
                  result={formatPaise(
                    productionPay({ ...prod, flatOn: false, ratePerShift: perShift, shifts: 20.5 }).gross,
                  )}
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
            hint={
              <>
                0 = no suggestion. Production pay itself is worked out on the{" "}
                <TextLink to="/hr/settings?tab=production_payroll">Production Payroll</TextLink> tab and in Manage
                Shifts.
              </>
            }
            disabled={readOnly}
          />
        </SettingBlock>
      </SettingsSection>

      <StickySave
        dirty={draft.dirty}
        saving={saving}
        onSave={save}
        onDiscard={draft.discard}
        saveLabel="Save Payroll Settings"
        disabled={readOnly || invalid || busy}
        hint={invalid ? "Fix the values marked in red first." : undefined}
      />

      <ConfirmChanges
        open={confirming}
        onOpenChange={setConfirming}
        title="Save the new PF and ESI rules?"
        changes={changes}
        confirmLabel="Save changes"
        onConfirm={() => void onSave()}
      >
        <p>
          Payslips generated from now on use these values. Payslips already generated keep their amounts until their
          month (or production period) is generated again, which re-prices it with the values of that moment.
        </p>
        {branchLogin && <p>You are signed in to a branch: these values apply to your branch's employees only.</p>}
      </ConfirmChanges>
    </div>
  );
}
