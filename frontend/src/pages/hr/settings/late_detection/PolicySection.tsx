import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { PreviewCard, PreviewLine, SettingBlock, SettingsSection } from "../kit/SettingBlock";
import { EXAMPLE_PAY_LINE, payFor, rupees } from "../attendance/example";
import { UnitInput } from "../attendance/UnitInput";
import { LATE_SECTIONS, lateText } from "../LateDetectionTab.meta";
import { slabsOf, type LateDraft } from "./form";
import { allowanceProblem, latePool, slabDeduction, slabWarnings, slabsProblem } from "./preview";
import { SlabEditor } from "./SlabEditor";

const block = (id: string) => ({ id, ...lateText(id) });

const GRID = [0, 2, 4, 6, 9, 12, 15, 20];

const cut = (shifts: number) =>
  shifts > 0 ? `-${shifts} shift${shifts > 1 ? "s" : ""} = ${rupees(payFor(shifts))}` : "No deduction";

/** The free allowance and the slab table: what the month's marks cost. */
export function PolicySection({
  draft,
  update,
  loaded,
  branchLogin,
  morningOn,
  eveningOn,
  cap,
  permissionsPriced,
}: {
  draft: LateDraft;
  update: (patch: Partial<LateDraft>) => void;
  loaded: boolean;
  branchLogin: boolean;
  morningOn: boolean | undefined;
  eveningOn: boolean | undefined;
  /** The monthly permission cap shown on this tab (typed or saved), for the month example. */
  cap: number;
  /** "Price permissions separately" is on (as typed): the extra permissions are not marks of this pool. */
  permissionsPriced: boolean;
}) {
  const allowanceError = allowanceProblem(draft.allowance);
  const slabError = slabsProblem(draft.slabs);
  const allowance = Number(draft.allowance);
  const slabs = slabsOf(draft);
  const warnings = slabError ? [] : slabWarnings(slabs);
  const ready = !allowanceError && !slabError;

  const branchNote = branchLogin
    ? "You are signed in for a branch: this is saved for your branch only, and payroll keeps using the company-wide value."
    : null;

  return (
    <SettingsSection
      id="late-policy-section"
      icon={AlertTriangle}
      title={LATE_SECTIONS.policy}
      purpose="What the month's marks cost a staff member. Production workers are not affected: they have their own page."
      usedBy={[
        { label: "Staff Payroll", to: "/hr/payroll" },
        { label: "Report Log", to: "/hr/attendance/report-log" },
        { label: "Employee apps" },
      ]}
      testId="late-policy-section"
    >
      <SettingBlock
        {...block("free-allowance")}
        labelFor="late-free-allowance"
        affects={[
          {
            where: "Staff Payroll",
            what: "only marks beyond this are priced by the slabs; the payslip's late summary shows how many were free",
            to: "/hr/payroll",
          },
          {
            where: "Report Log",
            what: "says 'The first N in a month are free' and prices the rest",
            to: "/hr/attendance/report-log",
          },
          { where: "Employee apps", what: "the deductions card and the My Shift screen use it" },
          { where: "Reports", what: "the late analysis and the permissions report", to: "/hr/reports" },
        ]}
        defaultText="3 marks"
        note={branchNote ?? "Changes pay for every staff member in every payroll generated from now on."}
        preview={
          <PreviewCard title="Example" scenario={`A month with this many marks, ${EXAMPLE_PAY_LINE}.`}>
            {ready ? (
              [4, 6, 12].map((total) => {
                const billable = Math.max(0, total - allowance);
                const shifts = slabDeduction(billable, slabs);
                return (
                  <PreviewLine
                    key={total}
                    label={`${total} marks: ${Math.min(total, allowance)} free, ${billable} billable`}
                    result={cut(shifts)}
                    tone={shifts > 0 ? "warn" : "good"}
                  />
                );
              })
            ) : (
              <p className="text-[12px] text-gray-500">Fix the values first to see the example.</p>
            )}
          </PreviewCard>
        }
      >
        <UnitInput
          id="late-free-allowance"
          value={draft.allowance}
          onChange={(v) => update({ allowance: v })}
          unit="marks a month"
          step={1}
          min={0}
          disabled={!loaded}
          error={allowanceError ?? undefined}
        />
      </SettingBlock>

      <SettingBlock
        {...block("deduction-slabs")}
        affects={[
          {
            where: "Staff Payroll",
            what: "late deduction = the row's shifts x that employee's daily rate (salary / the month's working days)",
            to: "/hr/payroll",
          },
          {
            where: "Report Log and employee apps",
            what: "show the same deduction for the month",
            to: "/hr/attendance/report-log",
          },
          { where: "Reports", what: "the late analysis prices marks with these rows", to: "/hr/reports" },
        ]}
        defaultText="every 3 billable marks a quarter shift: 3 → 0.25, 6 → 0.5 and so on up to 30 → 2.5"
        note="1 shift is one day's pay. The deduction never goes past the last row, however many marks there are."
        preview={
          <PreviewCard title="Worked example" scenario={`With the allowance and rows above, ${EXAMPLE_PAY_LINE}.`}>
            {ready ? (
              <>
                <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4" data-testid="late-worked-example">
                  {GRID.map((total) => {
                    const billable = Math.max(0, total - allowance);
                    const shifts = slabDeduction(billable, slabs);
                    return (
                      <div key={total} className="settings-line rounded-xl border border-blue-100 bg-white p-2">
                        <p className="text-[11px] text-gray-500">{total} marks</p>
                        <p className={cn("text-[12px] font-bold", shifts > 0 ? "text-amber-800" : "text-emerald-700")}>
                          {cut(shifts)}
                        </p>
                        {billable > 0 && <p className="text-[10px] text-gray-400">{billable} billable</p>}
                      </div>
                    );
                  })}
                </div>
                <MonthExample
                  allowance={allowance}
                  slabs={slabs}
                  cap={cap}
                  morningOn={morningOn}
                  eveningOn={eveningOn}
                  permissionsPriced={permissionsPriced}
                />
              </>
            ) : (
              <p className="text-[12px] text-gray-500">Fix the values first to see the example.</p>
            )}
          </PreviewCard>
        }
      >
        <SlabEditor
          keyName="fromLates"
          rows={draft.slabs}
          onChange={(rows) => update({ slabs: rows })}
          disabled={!loaded}
          labels={{ from: "From this many billable marks", shifts: "Shifts taken off" }}
          emptyText="No slabs: marks currently cost nothing. Add a slab to start deducting."
          min={0}
          nextStep={3}
          error={slabError}
          warnings={warnings}
          testId="slab"
        />
      </SettingBlock>
    </SettingsSection>
  );
}

/** One made-up month for one staff member, priced with the values on screen. */
function MonthExample({
  allowance,
  slabs,
  cap,
  morningOn,
  eveningOn,
  permissionsPriced,
}: {
  allowance: number;
  slabs: { fromLates: number; deductionShifts: number }[];
  cap: number;
  morningOn: boolean | undefined;
  eveningOn: boolean | undefined;
  permissionsPriced: boolean;
}) {
  const [month, setMonth] = useState({ late: "5", early: "1", permissions: "4" });
  const count = (v: string) => (Number.isFinite(Number(v)) ? Math.max(0, Math.trunc(Number(v))) : 0);
  const pool = latePool({
    lateIn: morningOn === false ? 0 : count(month.late),
    earlyOut: eveningOn === false ? 0 : count(month.early),
    approvedPermissions: count(month.permissions),
    cap,
    allowance,
    permissionsPriced,
  });
  const shifts = slabDeduction(pool.billable, slabs);
  const box = (key: keyof typeof month, label: string) => (
    <div className="space-y-1">
      <Label htmlFor={`late-example-${key}`} className="text-[11px]">
        {label}
      </Label>
      <Input
        id={`late-example-${key}`}
        type="number"
        min={0}
        value={month[key]}
        onChange={(e) => setMonth((m) => ({ ...m, [key]: e.target.value }))}
        className="h-8 w-[90px] bg-white text-xs"
      />
    </div>
  );
  return (
    <div className="settings-glass mt-2 space-y-1.5 rounded-2xl p-2.5" data-testid="late-month-example">
      <p className="text-[12px] font-bold text-blue-900">Try a month (not saved)</p>
      <div className="flex flex-wrap gap-3">
        {box("late", "Late days")}
        {box("early", "Early Out days")}
        {box("permissions", "Approved permissions")}
      </div>
      <PreviewLine
        label={
          permissionsPriced
            ? `Marks: ${pool.lateIn} Late + ${pool.earlyOut} Early Out (the ${pool.excess} permission${pool.excess === 1 ? "" : "s"} beyond the cap of ${cap} ${pool.excess === 1 ? "is" : "are"} priced separately, below)`
            : `Marks: ${pool.lateIn} Late + ${pool.earlyOut} Early Out + ${pool.excess} permission${pool.excess === 1 ? "" : "s"} beyond the cap of ${cap}`
        }
        result={`${pool.total} marks, ${pool.free} free, ${pool.billable} billable`}
        tone="neutral"
      />
      <PreviewLine label="Deducted from the month's salary" result={cut(shifts)} tone={shifts > 0 ? "bad" : "good"} />
      {(morningOn === false || eveningOn === false) && (
        <p className="text-[11px] text-gray-500">
          {morningOn === false ? "Morning Late-In is switched off, so Late days are not counted. " : ""}
          {eveningOn === false ? "Evening Early-Out is switched off, so Early Out days are not counted." : ""}
        </p>
      )}
    </div>
  );
}
