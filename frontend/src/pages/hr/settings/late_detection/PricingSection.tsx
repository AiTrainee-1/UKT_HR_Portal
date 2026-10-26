import { useState } from "react";
import { IndianRupee } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { PreviewCard, PreviewLine, SettingBlock, SettingsSection } from "../kit/SettingBlock";
import { ToggleField } from "../kit/Field";
import { EXAMPLE_DAY_PAY, EXAMPLE_PAY_LINE, rupees } from "../attendance/example";
import { UnitInput } from "../attendance/UnitInput";
import { LATE_SECTIONS, lateText } from "../LateDetectionTab.meta";
import { permissionSlabsOf, type PricingDraft } from "./form";
import {
  MAX_PERMISSION_ALLOWANCE,
  MAX_PERMISSION_FROM,
  PRICING_NEEDS_SLAB,
  monthOutcome,
  permissionAllowanceProblem,
  permissionSlabWarnings,
  permissionSlabsProblem,
  pricingProblem,
  type Slab,
} from "./preview";
import { SlabEditor } from "./SlabEditor";

const block = (id: string) => ({ id, ...lateText(id) });

const cut = (shifts: number, money: number) =>
  shifts > 0 ? `-${shifts} shift${shifts > 1 ? "s" : ""} = ${rupees(money)}` : "No deduction";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** What the switch does, side by side: the words of the two states, so the difference is read before it is turned on. */
function OffOn({ on }: { on: boolean }) {
  const box = (active: boolean) =>
    cn(
      "rounded-xl p-3 text-[12px] leading-snug ring-1",
      active ? "bg-blue-50 ring-blue-200" : "bg-white ring-slate-100",
    );
  return (
    <div className="grid gap-2 md:grid-cols-2" data-testid="pricing-off-on">
      <div className={box(!on)} data-testid="pricing-off-text" data-active={!on}>
        <p className="font-bold text-slate-900">Off (today)</p>
        <p className="mt-0.5 text-gray-600">
          An approved permission beyond the monthly cap becomes one more mark in the late pool, with the Late and Early
          Out days. They share the free allowance and are priced by the late slabs above.
        </p>
      </div>
      <div className={box(on)} data-testid="pricing-on-text" data-active={on}>
        <p className="font-bold text-slate-900">On</p>
        <p className="mt-0.5 text-gray-600">
          The extra permissions leave the late pool, which then holds the Late and Early Out days only. They are priced
          on their own: the first few are free, the rest by the permission slabs below. The same incident is never
          deducted twice.
        </p>
      </div>
    </div>
  );
}

/**
 * Permission pricing (staff only, company-wide, behind a switch): whether the approved permissions beyond the monthly cap
 * are priced on their own, with their own free permissions and slabs, instead of being marks of the late pool. Three
 * settings, one Save, a live month worked out from what is typed.
 */
export function PricingSection({
  draft,
  update,
  loaded,
  companyWideEditable,
  reported,
  cap,
  lateAllowance,
  lateSlabs,
  morningOn,
  eveningOn,
}: {
  draft: PricingDraft;
  update: (patch: Partial<PricingDraft>) => void;
  loaded: boolean;
  companyWideEditable: boolean;
  /** The server reports the three keys (a backend that predates them cannot change them). */
  reported: boolean;
  /** The monthly permission cap and the late policy shown on this tab (as typed), for the month example. */
  cap: number;
  lateAllowance: number;
  lateSlabs: Slab[];
  morningOn: boolean | undefined;
  eveningOn: boolean | undefined;
}) {
  const locked = !loaded || !companyWideEditable || !reported;
  const allowanceError = permissionAllowanceProblem(draft.allowance);
  const slabError = permissionSlabsProblem(draft.slabs);
  const slabs = permissionSlabsOf(draft);
  const warnings = slabError ? [] : permissionSlabWarnings(slabs);
  const needsSlab = draft.enabled && draft.slabs.length === 0;
  const ready = pricingProblem(draft) === null;

  const [month, setMonth] = useState({ late: "2", early: "1", permissions: "6" });
  const count = (v: string) => (Number.isFinite(Number(v)) ? Math.max(0, Math.trunc(Number(v))) : 0);
  const outcome = (enabled: boolean) =>
    monthOutcome({
      lateIn: morningOn === false ? 0 : count(month.late),
      earlyOut: eveningOn === false ? 0 : count(month.early),
      approvedPermissions: count(month.permissions),
      cap,
      allowance: lateAllowance,
      slabs: lateSlabs,
      pricing: { enabled, freeAllowance: count(draft.allowance), slabs },
      dayRate: EXAMPLE_DAY_PAY,
    });
  const result = outcome(draft.enabled);
  const other = outcome(!draft.enabled);
  const p = result.permissions;

  const box = (key: keyof typeof month, label: string) => (
    <div className="space-y-1">
      <Label htmlFor={`pricing-example-${key}`} className="text-[11px]">
        {label}
      </Label>
      <Input
        id={`pricing-example-${key}`}
        type="number"
        min={0}
        value={month[key]}
        onChange={(e) => setMonth((m) => ({ ...m, [key]: e.target.value }))}
        className="h-8 w-[90px] bg-white text-xs"
      />
    </div>
  );

  return (
    <SettingsSection
      id="permission-pricing-section"
      icon={IndianRupee}
      title={LATE_SECTIONS.pricing}
      purpose="Staff only, and company-wide. Whether the approved permissions beyond the monthly cap are priced on their own, with their own free permissions and slabs, instead of being marks of the late pool. Production workers' permissions are never priced."
      usedBy={[
        { label: "Staff Payroll", to: "/hr/payroll" },
        { label: "Report Log", to: "/hr/attendance/report-log" },
        { label: "Permissions", to: "/hr/leave" },
        { label: "Employee apps" },
      ]}
      testId="permission-pricing-section"
    >
      <SettingBlock
        {...block("permission-pricing")}
        labelFor="permission-pricing-switch"
        defaultText="Off"
        affects={[
          {
            where: "Staff Payroll",
            what: "on: the payslip shows a permission deduction of its own beside the late deduction, and the late pool no longer counts the extra permissions. Off: nothing changes.",
            to: "/hr/payroll",
          },
          {
            where: "Report Log and employee apps",
            what: "show the same split of the month's deduction",
            to: "/hr/attendance/report-log",
          },
          { where: "Reports", what: "the late analysis and the permissions report", to: "/hr/reports" },
          { where: "Production workers", what: "never: their permissions are not priced" },
        ]}
        note="Changes pay for every staff member in every payroll generated from now on. Payslips already generated keep their amounts until that month's payroll is generated again."
      >
        <ToggleField
          id="permission-pricing-switch"
          checked={draft.enabled}
          onChange={(v) => update({ enabled: v })}
          onLabel="On - extra permissions are priced on their own"
          offLabel="Off - extra permissions are marks of the late pool"
          disabled={locked}
        />
        <OffOn on={draft.enabled} />
        {needsSlab && (
          <p
            role="alert"
            className="rounded-lg bg-red-50 px-2.5 py-1.5 text-xs font-medium text-red-800"
            data-testid="pricing-needs-slab"
          >
            {PRICING_NEEDS_SLAB} The server refuses it with no rows to price by.
          </p>
        )}
        {!companyWideEditable && (
          <p data-testid="company-wide-note-pricing" className="text-[11px] font-medium text-slate-500">
            Company-wide rule - set by an administrator
          </p>
        )}
        {companyWideEditable && loaded && !reported && (
          <p data-testid="pricing-not-reported" className="text-[11px] font-medium text-slate-500">
            Not reported by the server, so it cannot be changed here
          </p>
        )}
      </SettingBlock>

      <SettingBlock
        {...block("permission-free-allowance")}
        labelFor="permission-free-allowance-input"
        defaultText="0 (the first extra permission is priced)"
        affects={[
          {
            where: "Staff Payroll",
            what: "only extra permissions beyond this many are priced by the permission slabs; the payslip's permission summary shows how many were free",
            to: "/hr/payroll",
          },
          { where: "Report Log and employee apps", what: "say how many were free" },
        ]}
        note="Counts only the permissions beyond the monthly cap, and only while permissions are priced separately."
        preview={
          <PreviewCard title="Example" scenario={`Extra permissions beyond the cap in a month, ${EXAMPLE_PAY_LINE}.`}>
            {permissionAllowanceProblem(draft.allowance) || permissionSlabsProblem(draft.slabs) ? (
              <p className="text-[12px] text-gray-500">Fix the values first to see the example.</p>
            ) : (
              [1, 2, 4].map((extra) => {
                const free = Math.min(extra, count(draft.allowance));
                const billable = Math.max(0, extra - count(draft.allowance));
                return (
                  <PreviewLine
                    key={extra}
                    label={`${plural(extra, "extra permission")}: ${free} free, ${billable} billable`}
                    result={billable > 0 ? "priced by the slabs" : "costs nothing"}
                    tone={billable > 0 ? "warn" : "good"}
                  />
                );
              })
            )}
          </PreviewCard>
        }
      >
        <UnitInput
          id="permission-free-allowance-input"
          value={draft.allowance}
          onChange={(v) => update({ allowance: v })}
          unit="extra permissions a month"
          step={1}
          min={0}
          max={MAX_PERMISSION_ALLOWANCE}
          disabled={locked}
          error={allowanceError ?? undefined}
        />
      </SettingBlock>

      <SettingBlock
        {...block("permission-deduction-slabs")}
        defaultText="no rows (turning the pricing on needs at least one)"
        affects={[
          {
            where: "Staff Payroll",
            what: "permission deduction = the row's shifts x that employee's daily rate (salary / the month's working days), its own line on the payslip",
            to: "/hr/payroll",
          },
          {
            where: "Report Log and employee apps",
            what: "show the same deduction for the month",
            to: "/hr/attendance/report-log",
          },
          {
            where: "Reports",
            what: "the late analysis and the permissions report price with these rows",
            to: "/hr/reports",
          },
        ]}
        note="1 shift is one day's pay. The deduction never goes past the last row, however many extra permissions there are. Up to 50 rows."
        preview={
          <PreviewCard
            title="Try a month (not saved)"
            scenario={`Made up, ${EXAMPLE_PAY_LINE}. Cap of ${cap} permissions.`}
          >
            {ready ? (
              <div className="space-y-1.5" data-testid="pricing-month-example">
                <div className="flex flex-wrap gap-3">
                  {box("permissions", "Approved permissions")}
                  {box("late", "Late days")}
                  {box("early", "Early Out days")}
                </div>
                <PreviewLine
                  label={`${plural(p.approved, "approved permission")}, cap ${p.cap}`}
                  result={`${p.excess} beyond the cap`}
                  tone="neutral"
                  testId="pricing-example-excess"
                />
                {draft.enabled ? (
                  <>
                    <PreviewLine
                      label={`Free extra permissions: ${p.freeAllowance}`}
                      result={`${p.free} free, ${p.billable} billable`}
                      tone="neutral"
                      testId="pricing-example-billable"
                    />
                    <PreviewLine
                      label="Slab row reached"
                      result={
                        p.row
                          ? `from ${p.row.fromPermissions}: ${p.row.deductionShifts} shift`
                          : "none: below the first row"
                      }
                      tone="neutral"
                      testId="pricing-example-row"
                    />
                    <PreviewLine
                      label="Deducted for permissions"
                      result={cut(p.shifts, p.penalty)}
                      tone={p.shifts > 0 ? "bad" : "good"}
                      testId="pricing-example-permission-cut"
                    />
                    <PreviewLine
                      label={`Late pool, Late and Early Out only: ${result.pool.total} marks`}
                      result={`${result.pool.free} free, ${result.pool.billable} billable: ${cut(result.poolShifts, result.poolPenalty)}`}
                      tone="neutral"
                      testId="pricing-example-pool"
                    />
                  </>
                ) : (
                  <>
                    <PreviewLine
                      label={`Priced separately is off: the ${plural(p.excess, "extra permission")} ${p.excess === 1 ? "is a mark" : "are marks"} of the late pool of ${result.pool.total}`}
                      result={`${result.pool.free} free, ${result.pool.billable} billable`}
                      tone="neutral"
                      testId="pricing-example-pool"
                    />
                    <PreviewLine
                      label="Late pool deduction"
                      result={cut(result.poolShifts, result.poolPenalty)}
                      tone={result.poolShifts > 0 ? "bad" : "good"}
                    />
                  </>
                )}
                <PreviewLine
                  label="Deducted from the month's salary"
                  result={cut(result.totalShifts, result.totalPenalty)}
                  tone={result.totalShifts > 0 ? "bad" : "good"}
                  testId="pricing-example-total"
                />
                {(draft.slabs.length > 0 || draft.enabled) && (
                  <p className="text-[11px] text-gray-500" data-testid="pricing-example-other">
                    The same month with the switch {draft.enabled ? "off" : "on"}:{" "}
                    {cut(other.totalShifts, other.totalPenalty)}.
                  </p>
                )}
                {(morningOn === false || eveningOn === false) && (
                  <p className="text-[11px] text-gray-500">
                    {morningOn === false ? "Morning Late-In is switched off, so Late days are not counted. " : ""}
                    {eveningOn === false ? "Evening Early-Out is switched off, so Early Out days are not counted." : ""}
                  </p>
                )}
                <p className="text-[11px] text-gray-500">
                  A Late or Early Out day that came with one of the extra permissions is counted once, never twice.
                </p>
              </div>
            ) : (
              <p className="text-[12px] text-gray-500">Fix the values first to see the example.</p>
            )}
          </PreviewCard>
        }
      >
        <SlabEditor
          keyName="fromPermissions"
          rows={draft.slabs}
          onChange={(rows) => update({ slabs: rows })}
          disabled={locked}
          labels={{ from: "From permissions", shifts: "Deduct shifts" }}
          emptyText="No slabs: extra permissions cost nothing. Add at least one slab before turning the pricing on."
          min={1}
          max={MAX_PERMISSION_FROM}
          nextStep={1}
          error={slabError}
          warnings={warnings}
          testId="permission-slab"
        />
      </SettingBlock>
    </SettingsSection>
  );
}
