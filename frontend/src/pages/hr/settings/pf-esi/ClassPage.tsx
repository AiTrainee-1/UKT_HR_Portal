import { useMemo, useState, type ReactNode } from "react";
import { Factory, Users } from "lucide-react";
import { Link } from "wouter";
import type { PfEsiListKey, PfEsiSettings } from "@/lib/api-client/custom-hooks";
import { pagePath } from "@/pages/hr/compensation/routes";
import { PreviewCard, PreviewLine, SettingBlock, SettingsSection } from "../kit/SettingBlock";
import { PF_ESI_SECTIONS, pfEsiText } from "../PfEsiTab.meta";
import { parseNumber, RANGES, type NumberRule } from "../payroll/form";
import { formatPaise } from "../payroll/preview";
import { InfoBox, NumberInput } from "../payroll/ui";
import {
  BASIS_SHORT,
  DEFAULT_MAX_RULES,
  listKey,
  previewRules,
  rangeWords,
  type RuleClass,
  type RuleDraft,
  type RuleRow,
  type Validation,
} from "./form";
import {
  EXAMPLE_WORKING_DAYS,
  PERIOD_FACTORS,
  productionExample,
  staffExample,
  type Deduction,
  type Example,
  type ProductionPeriod,
} from "./preview";
import { RuleList } from "./RuleList";

const block = (id: string) => ({ id, ...pfEsiText(id) });

const DAYS_RULE: NumberRule = { min: 0, max: 31, decimals: 1 };

const PERIOD_OPTIONS: { value: ProductionPeriod; label: string }[] = [
  { value: "weekly", label: "Weekly (monthly estimate = pay x 4)" },
  { value: "biweekly", label: "BiWeekly (monthly estimate = pay x 2)" },
  { value: "monthly", label: "Monthly (monthly estimate = pay x 1)" },
];

/** What a deduction line of the example says: the rule that fits and what it comes to, or why there is none. */
function deductionLines(kind: "PF" | "ESI", d: Deduction, ruleCount: number, base: number) {
  if (d.match) {
    const { rule, tested, index } = d.match;
    return {
      label: `${kind}: rule ${index + 1} "${rule.label}" fits - ${BASIS_SHORT[rule.basis]} ${formatPaise(tested)} is within ${rangeWords(rule.min, rule.max)}`,
      result: `${d.rate}% of ${formatPaise(base)} = ${formatPaise(d.amount)}`,
      tone: "good" as const,
    };
  }
  return {
    label: ruleCount === 0 ? `${kind}: there are no ${kind} rules` : `${kind}: no ${kind} rule fits this amount`,
    result: `no ${kind}`,
    tone: "neutral" as const,
  };
}

/** Where a number the example reads from a box is wrong, in the box's own words; the example then keeps the default. */
function sample(text: string, rule: NumberRule, fallback: number) {
  const { value, error } = parseNumber(text, rule);
  return { value: value ?? fallback, error };
}

function Bullets({ children }: { children: ReactNode }) {
  return <ul className="list-disc space-y-1 pl-5">{children}</ul>;
}

/**
 * One page of the PF & ESI tab (Staff or Production): the plain explanation with a live example that follows the rules on
 * screen, then the PF rules and the ESI rules, each an editable list. Everything is read-only when `locked`.
 */
export function ClassPage({
  cls,
  draft,
  validation,
  onList,
  settings,
  locked,
}: {
  cls: RuleClass;
  draft: RuleDraft;
  validation: Validation;
  onList: (key: PfEsiListKey, rows: RuleRow[]) => void;
  settings: PfEsiSettings;
  locked: boolean;
}) {
  const staff = cls === "staff";
  const pfKey = listKey(cls, "pf");
  const esiKey = listKey(cls, "esi");
  const maxRules = settings.limits?.maxRulesPerList ?? DEFAULT_MAX_RULES;
  const pfRows = draft[pfKey];
  const esiRows = draft[esiKey];
  const pfRules = useMemo(() => previewRules(pfRows), [pfRows]);
  const esiRules = useMemo(() => previewRules(esiRows), [esiRows]);

  // the example's own inputs (an illustration: never saved)
  const [salary, setSalary] = useState("30000");
  const [days, setDays] = useState(String(EXAMPLE_WORKING_DAYS));
  const [periodPay, setPeriodPay] = useState("7500");
  const [cycle, setCycle] = useState<ProductionPeriod>("weekly");
  const salaryRead = sample(salary, RANGES.amount, 30000);
  const daysRead = sample(days, DAYS_RULE, EXAMPLE_WORKING_DAYS);
  const payRead = sample(periodPay, RANGES.amount, 7500);

  const staffResult = staffExample({ salary: salaryRead.value, daysPaid: daysRead.value, pfRules, esiRules });
  const prodResult = productionExample({ periodPay: payRead.value, cycle, pfRules, esiRules });
  const result: Example = staff ? staffResult : prodResult;
  const skipped = pfRows.length - pfRules.length + (esiRows.length - esiRules.length);

  const pf = deductionLines("PF", result.pf, pfRules.length, result.base);
  const esi = deductionLines("ESI", result.esi, esiRules.length, result.base);
  const basePhrase = staff
    ? `${formatPaise(result.base)} (the first portion, ${daysRead.value} of ${EXAMPLE_WORKING_DAYS} days paid)`
    : `${formatPaise(result.base)} (half of the period's pay)`;

  const who = staff ? "staff" : "production workers";
  const section = PF_ESI_SECTIONS[cls];

  return (
    <SettingsSection
      icon={staff ? Users : Factory}
      title={section}
      purpose={
        staff
          ? "The rules for staff (monthly salary) payslips. Production workers have their own page."
          : "The rules for production (shift or weekly paid) workers. Staff have their own page."
      }
      usedBy={
        staff
          ? [
              { label: "Staff Payroll", to: "/hr/payroll" },
              { label: "Compensation (CTC)", to: pagePath("ctc") },
              { label: "Report Center", to: "/hr/reports" },
            ]
          : [
              { label: "Production Payroll", to: "/hr/production-payroll" },
              { label: "Compensation (CTC)", to: pagePath("ctc") },
              { label: "Report Center", to: "/hr/reports" },
            ]
      }
      testId={`pf-esi-page-${cls}`}
    >
      <SettingBlock
        {...block(staff ? "staff-pf-esi-how" : "prod-pf-esi-how")}
        defaultText="No rules until the Super Admin adds them"
        affects={[
          {
            where: staff ? "Staff Payroll" : "Production Payroll",
            what: `PF and ESI on every ${staff ? "staff" : "production"} payslip generated from now on follow these rules, for employees switched ON in Co Emp only.`,
            to: staff ? "/hr/payroll" : "/hr/production-payroll",
          },
          {
            where: "Employees - Co Emp",
            what: "the Co Emp switch, not the salary, decides who these rules apply to.",
            to: "/hr/employees",
          },
        ]}
        note="Payslips already generated keep their amounts; generating a month again uses the rules as they are then. An employee who is not switched ON in Co Emp pays no PF or ESI, even if they used to under the old flat rates."
        preview={
          <PreviewCard
            title="Example (an illustration)"
            scenario={
              staff
                ? `A staff member on ${formatPaise(staffResult.amounts.total)} a month with the automatic 50% split, switched ON in Co Emp. Their recorded split can differ.`
                : `A production worker who earned ${formatPaise(prodResult.periodPaise)} in a ${cycle} pay period, switched ON in Co Emp: a monthly estimate of ${formatPaise(prodResult.monthlyEquivalent)}, with the automatic 50% split.`
            }
            testId={`pf-esi-example-${cls}`}
          >
            <PreviewLine
              label="The rules measure"
              result={`Basic ${formatPaise(result.amounts.basic)} | Basic + DA + Retaining ${formatPaise(result.amounts.first_portion)} | Full month ${formatPaise(result.amounts.total)}`}
              testId={`pf-esi-example-${cls}-amounts`}
            />
            <PreviewLine {...pf} testId={`pf-esi-example-${cls}-pf`} />
            <PreviewLine {...esi} testId={`pf-esi-example-${cls}-esi`} />
            <PreviewLine
              label={`PF + ESI taken from ${basePhrase}`}
              result={formatPaise(result.total)}
              tone={result.total > 0 ? "info" : "neutral"}
              testId={`pf-esi-example-${cls}-total`}
            />
            {skipped > 0 && (
              <PreviewLine
                tone="warn"
                label="Rules with a problem in a box"
                result={`${skipped} left out of this example`}
              />
            )}
          </PreviewCard>
        }
      >
        <InfoBox testId={`pf-esi-how-${cls}`}>
          <p className="font-semibold">How PF and ESI are worked out for {who}</p>
          <Bullets>
            <li>
              Only employees switched ON in{" "}
              <Link href="/hr/employees" className="font-semibold text-blue-700 underline">
                Employees - Co Emp
              </Link>{" "}
              are subject to these rules. Everyone else has no PF and no ESI.
            </li>
            <li>
              The amount is the rule's percentage of <strong>Basic + DA + Retaining Allowance</strong>, the first 50%
              portion of the {staff ? "salary, prorated by the days paid" : "pay earned in the period"}.
            </li>
            <li>
              Who is eligible is decided by the rule's <strong>range</strong>, measured on the basis you choose (Basic
              salary is the usual one) against the employee's full monthly amount, so a short month never changes who is
              eligible.
              {!staff &&
                " For a production worker the monthly amount is estimated: the period's pay x 4 on Weekly, x 2 on BiWeekly, x 1 on Monthly."}
            </li>
            <li>The rules are checked from the top of each list: the first one whose range fits applies.</li>
            <li>When no rule fits, nothing is deducted.</li>
          </Bullets>
        </InfoBox>

        {staff ? (
          <div className="flex flex-wrap items-start gap-x-6 gap-y-3" data-testid="pf-esi-example-inputs-staff">
            <div className="space-y-1">
              <label htmlFor="staff-example-salary" className="text-xs font-semibold text-gray-700">
                Try a monthly salary
              </label>
              <NumberInput
                id="staff-example-salary"
                value={salary}
                onChange={setSalary}
                prefix="₹"
                error={salaryRead.error}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="staff-example-days" className="text-xs font-semibold text-gray-700">
                Days paid (of {EXAMPLE_WORKING_DAYS})
              </label>
              <NumberInput id="staff-example-days" value={days} onChange={setDays} error={daysRead.error} />
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-start gap-x-6 gap-y-3" data-testid="pf-esi-example-inputs-production">
            <div className="space-y-1">
              <label htmlFor="prod-example-pay" className="text-xs font-semibold text-gray-700">
                Try the pay earned in a period
              </label>
              <NumberInput
                id="prod-example-pay"
                value={periodPay}
                onChange={setPeriodPay}
                prefix="₹"
                error={payRead.error}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="prod-example-cycle" className="text-xs font-semibold text-gray-700">
                Pay cycle
              </label>
              <select
                id="prod-example-cycle"
                value={cycle}
                onChange={(e) => setCycle(e.target.value as ProductionPeriod)}
                className="h-9 w-full max-w-sm rounded-md border border-input bg-background px-3 text-sm"
              >
                {PERIOD_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <p className="text-xs text-gray-500">
                x {PERIOD_FACTORS[cycle]} gives the monthly amount the rules test.
              </p>
            </div>
          </div>
        )}
      </SettingBlock>

      <SettingBlock
        {...block(staff ? "staff-pf-rules" : "prod-pf-rules")}
        className="lg:grid-cols-1"
        defaultText="No rules: nobody pays PF"
        affects={[
          {
            where: staff ? "Staff Payroll" : "Production Payroll",
            what: staff
              ? "PF on each staff payslip generated from now on is the matching rule's percentage of Basic + DA + Retaining Allowance, prorated by the days paid."
              : "PF on each production payslip generated from now on is the matching rule's percentage of the first half of the period's pay.",
            to: staff ? "/hr/payroll" : "/hr/production-payroll",
          },
          {
            where: "Compensation - CTC Breakdown",
            what: "Employer PF is the matching rule's percentage of the first portion of the monthly salary.",
            to: pagePath("ctc"),
          },
          {
            where: "Report Center",
            what: "the PF / ESI coverage report counts who pays PF under these rules.",
            to: "/hr/reports",
          },
        ]}
      >
        <RuleList
          listKey={pfKey}
          rows={pfRows}
          check={validation.lists[pfKey]}
          onChange={(rows) => onList(pfKey, rows)}
          basisOptions={settings.basisOptions}
          maxRules={maxRules}
          locked={locked}
        />
      </SettingBlock>

      <SettingBlock
        {...block(staff ? "staff-esi-rules" : "prod-esi-rules")}
        className="lg:grid-cols-1"
        defaultText="No rules: nobody pays ESI"
        affects={[
          {
            where: staff ? "Staff Payroll" : "Production Payroll",
            what: staff
              ? "ESI on each staff payslip generated from now on is the matching rule's percentage of Basic + DA + Retaining Allowance, prorated by the days paid."
              : "ESI on each production payslip generated from now on is the matching rule's percentage of the first half of the period's pay.",
            to: staff ? "/hr/payroll" : "/hr/production-payroll",
          },
          {
            where: "Compensation - CTC Breakdown",
            what: "Employer ESI is the matching rule's percentage of the first portion of the monthly salary.",
            to: pagePath("ctc"),
          },
          {
            where: "Report Center",
            what: "the PF / ESI coverage report counts who pays ESI under these rules.",
            to: "/hr/reports",
          },
        ]}
      >
        <RuleList
          listKey={esiKey}
          rows={esiRows}
          check={validation.lists[esiKey]}
          onChange={(rows) => onList(esiKey, rows)}
          basisOptions={settings.basisOptions}
          maxRules={maxRules}
          locked={locked}
        />
      </SettingBlock>
    </SettingsSection>
  );
}
