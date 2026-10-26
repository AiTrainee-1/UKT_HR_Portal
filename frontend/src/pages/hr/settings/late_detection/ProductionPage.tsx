import { useState } from "react";
import { AlertTriangle, CalendarRange, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PillTabs } from "@/components/ui/pill-tabs";
import { useListShifts, type PayCycle, type PayrollSettingsItem } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { ToggleField } from "../kit/Field";
import { PreviewCard, PreviewLine, SettingBlock, SettingsSection } from "../kit/SettingBlock";
import { CYCLE_LATE_SECTIONS, LATE_SECTIONS, lateText } from "../LateDetectionTab.meta";
import { numberOr, RANGES } from "../payroll/form";
import { formatPaise } from "../payroll/preview";
import { ConfirmChanges, NumberInput, SelectInput, TextLink } from "../payroll/ui";
import { CYCLE_INFO, CYCLES } from "../production-payroll/cycles";
import { judgeProductionDay, productionLatePenalty } from "../production-payroll/preview";
import { cutText, PER_SHIFT, SlabExample, SlabTable } from "../production-payroll/SlabEditor";
import {
  changedCycles,
  cycleLateErrors,
  cycleLateRules,
  deductsFromEveryone,
  hasCycleLateErrors,
  type ProductionLateForm,
} from "./production";

const block = (id: string) => ({ id, ...lateText(id) });

/** The example shift when Manage Shifts has no production shift with times. */
const EXAMPLE_SHIFT = { name: "Production A", start: "08:00", end: "17:00", grace: 10 };

const MODE_NAME: Record<string, string> = { strict: "Strict", simple: "Simple" };

const clock = (value: string): string => value.slice(0, 5);

/** "08:10" plus some minutes and seconds, for the example punches. */
function at(base: string, minutes: number, seconds = 0): string {
  const [h, m] = base.split(":").map(Number);
  const total = h * 3600 + m * 60 + minutes * 60 + seconds;
  const hh = String(Math.floor(total / 3600) % 24).padStart(2, "0");
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const ss = total % 60;
  return ss ? `${hh}:${mm}:${String(ss).padStart(2, "0")}` : `${hh}:${mm}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Settings -> Late Detection -> Production: whether a late day costs a production worker pay, what makes a day late, and
 * each pay cycle's free late days and deduction slabs (one pill per cycle). Separate from the staff pool: it counts per
 * pay period (not per month), has no permission pool and is priced in shifts of each worker's own Salary Per Shift. The
 * form state, the Save bar and the confirm are the tab's; this draws the page.
 */
export function ProductionPage({
  form,
  saved,
  update,
  settings,
  cycle,
  onCycle,
  branchLogin,
  readOnly,
  busy,
  onUseShared,
}: {
  form: ProductionLateForm;
  saved: ProductionLateForm;
  update: (patch: Partial<ProductionLateForm>) => void;
  /** The saved settings: each cycle's late rules price the switch example. */
  settings: PayrollSettingsItem;
  cycle: PayCycle;
  onCycle: (cycle: PayCycle) => void;
  branchLogin: boolean;
  readOnly: boolean;
  /** A save is running. */
  busy: boolean;
  onUseShared: (cycle: PayCycle) => Promise<void>;
}) {
  const [confirmingShared, setConfirmingShared] = useState(false);
  const changed = changedCycles(form, saved);
  // the shifts of Manage Shifts: the first active production shift with times is the mode example's shift
  const shifts = useListShifts().data;

  const rules = CYCLES.map((c) => ({ cycle: c, ...CYCLE_INFO[c], ...cycleLateRules(settings, c) }));
  const priced = rules.map((r) => ({ ...r, ...productionLatePenalty(7, r.allowance, r.slabs, PER_SHIFT) }));

  const real = (shifts ?? []).find((s) => s.shiftType === "production" && s.isActive && s.startTime && s.endTime);
  const shift = real
    ? { name: real.name, start: clock(real.startTime!), end: clock(real.endTime!), grace: real.gracePeriodMinutes || 0 }
    : EXAMPLE_SHIFT;
  const judge = (firstPunch: string, lastPunch?: string) =>
    judgeProductionDay({
      shiftStart: shift.start,
      shiftEnd: shift.end,
      graceMinutes: shift.grace,
      firstPunch,
      lastPunch,
      mode: form.mode,
    });
  const arrivals = [at(shift.start, shift.grace), at(shift.start, shift.grace, 20), at(shift.start, shift.grace + 1)];
  const earlyLeave = at(shift.end, -shift.grace - 1);

  return (
    <div className="space-y-4" data-testid="late-page-production">
      <SettingsSection
        icon={AlertTriangle}
        title={LATE_SECTIONS.production}
        purpose="Whether a late day costs a production worker pay, and what makes a day late, on every pay cycle. Off by default. This is not the Staff page: it counts per pay period (not per month), has no permission pool, and is priced in shifts of each worker's own Salary Per Shift."
        usedBy={CYCLES.map((c) => ({
          label: `Production Payroll - ${CYCLE_INFO[c].label}`,
          to: CYCLE_INFO[c].path,
        }))}
        testId="production-late-section"
      >
        <SettingBlock
          {...block("prod-late-switch")}
          labelFor="prod-late-enabled"
          defaultText="Off"
          affects={[
            {
              where: "Production Payroll - every cycle",
              what: "On: late days in the period beyond the cycle's free allowance are priced by the cycle's slabs and taken off take-home pay (gross stays shifts x rate); the payslip breakdown shows the late summary and each late day's reason.",
              to: CYCLE_INFO.weekly.path,
            },
            {
              where: "Production Payroll - every cycle",
              what: "Off: no late deduction, and each day's Late flag on the payslip stays the Attendance punch-time flag.",
              to: CYCLE_INFO.weekly.path,
            },
            {
              where: "Generate dialog of each cycle",
              what: 'summarises the rule ("Enabled - 3 free - 2 slabs").',
              to: CYCLE_INFO.weekly.path,
            },
          ]}
          note={
            <>
              On with no slabs deducts nothing. Payslips already generated keep their deduction; generating a past
              period again applies the rules of that moment to it.
              {branchLogin &&
                " You are signed in to a branch: what you save here applies to your branch's employees only."}
            </>
          }
          preview={
            <PreviewCard
              scenario={`7 late days in one pay period, ${formatPaise(PER_SHIFT * 100)} a shift, with each cycle's saved allowance and slabs.`}
              testId="production-late-switch-preview"
            >
              {priced.map((r) => (
                <PreviewLine
                  key={r.cycle}
                  label={`Switch on, ${r.label} (${plural(r.allowance, "free day")}, ${plural(r.slabs.length, "slab")})`}
                  result={`${r.billable} billable - ${cutText(r.shifts, r.penalty)}`}
                  tone={form.enabled ? "info" : "neutral"}
                />
              ))}
              <PreviewLine
                label={`Switch off${form.enabled ? "" : " (as set now)"}`}
                result="lateness ignored - no deduction"
                tone={form.enabled ? "neutral" : "info"}
              />
            </PreviewCard>
          }
        >
          <ToggleField
            id="prod-late-enabled"
            checked={form.enabled}
            onChange={(v) => update({ enabled: v })}
            onLabel="On - late production days cost shifts of pay"
            offLabel="Off - production payroll ignores lateness"
            disabled={readOnly}
          />
        </SettingBlock>

        <SettingBlock
          {...block("prod-attendance-mode")}
          labelFor="prod-attendance-mode-input"
          defaultText="Strict"
          affects={[
            {
              where: "Production Payroll - every cycle",
              what: "only while the switch above is on: Strict also counts a day as late when the last punch is before the shift end minus grace.",
              to: CYCLE_INFO.weekly.path,
            },
            {
              where: "Generate dialog of each cycle",
              what: "shows the mode in force.",
              to: CYCLE_INFO.weekly.path,
            },
            { where: "Shifts earned and pay", what: "never use it." },
          ]}
          note="Punches are compared to the second: 08:10:20 is late against a deadline of 08:10. The Attendance tab has its own Strict / Simple setting for staff, which does not apply to production."
          preview={
            <PreviewCard
              scenario={`${real ? "Your production shift" : "An example shift"} ${shift.name}, ${shift.start}-${shift.end}, grace ${shift.grace} min: on time until ${at(shift.start, shift.grace)}, ${MODE_NAME[form.mode] ?? form.mode} mode.`}
              testId="production-mode-preview"
            >
              {arrivals.map((punch) => {
                const day = judge(punch);
                return (
                  <PreviewLine
                    key={punch}
                    label={`First punch ${punch}`}
                    result={day.late ? "late" : "on time"}
                    tone={day.late ? "warn" : "good"}
                  />
                );
              })}
              {(() => {
                const day = judge(at(shift.start, 0), earlyLeave);
                return (
                  <PreviewLine
                    label={`In on time, last punch ${earlyLeave} (before ${at(shift.end, -shift.grace)})`}
                    result={day.late ? "late (left early)" : "not late in Simple mode"}
                    tone={day.late ? "warn" : "good"}
                  />
                );
              })()}
              <PreviewLine label="Late arrival and early leaving on the same day" result="one late day, not two" />
            </PreviewCard>
          }
        >
          <SelectInput
            id="prod-attendance-mode-input"
            value={form.mode}
            onChange={(v) => update({ mode: v })}
            disabled={readOnly}
            className="max-w-xs"
            options={[
              { value: "strict", label: "Strict - late arrival or early leaving" },
              { value: "simple", label: "Simple - late arrival only" },
            ]}
          />
        </SettingBlock>
      </SettingsSection>

      <div className="flex flex-wrap items-center gap-3" data-testid="production-late-cycle-pills">
        <PillTabs
          items={CYCLES.map((c) => ({ value: c, label: CYCLE_INFO[c].label, icon: <CalendarRange size={13} /> }))}
          value={cycle}
          onChange={(v) => onCycle(v as PayCycle)}
          baseColor="#0f172a"
          pillBg="#f1f5f9"
        />
        {changed.filter((c) => c !== cycle).length > 0 && (
          <span
            className="rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-800 ring-1 ring-amber-200"
            data-testid="production-late-cycle-unsaved"
          >
            Not saved yet:{" "}
            {changed
              .filter((c) => c !== cycle)
              .map((c) => CYCLE_INFO[c].label)
              .join(", ")}
          </span>
        )}
      </div>

      <CycleLateSection
        key={cycle}
        cycle={cycle}
        form={form}
        saved={saved}
        update={update}
        settings={settings}
        branchLogin={branchLogin}
        readOnly={readOnly}
        busy={busy}
        onUseSharedClick={() => setConfirmingShared(true)}
      />

      <ConfirmChanges
        open={confirmingShared}
        onOpenChange={setConfirmingShared}
        title={`Use the shared late rules for ${CYCLE_INFO[cycle].label} again?`}
        changes={[
          {
            label: "Free late days a period",
            from: saved.cycles[cycle].lateFreeAllowance,
            to: String(settings.prodLateFreeAllowance ?? 3),
          },
          {
            label: "Deduction slabs",
            from: plural(saved.cycles[cycle].lateSlabs.length, "row"),
            to: plural((settings.prodLateDeductionSlabs ?? []).length, "row"),
          },
        ]}
        confirmLabel="Use the shared rules"
        onConfirm={() => void onUseShared(cycle)}
      >
        <p>
          {CYCLE_INFO[cycle].label} goes back to the production-wide values saved before the cycles existed (
          {plural(settings.prodLateFreeAllowance ?? 3, "free late day")},{" "}
          {plural((settings.prodLateDeductionSlabs ?? []).length, "slab")}) and follows them from now on. Payslips
          already generated keep their late deduction; any unsaved edits to these two settings are dropped.
        </p>
      </ConfirmChanges>
    </div>
  );
}

/** One pay cycle's free late days and slabs, with where they come from (its own or the shared values). */
function CycleLateSection({
  cycle,
  form,
  saved,
  update,
  settings,
  branchLogin,
  readOnly,
  busy,
  onUseSharedClick,
}: {
  cycle: PayCycle;
  form: ProductionLateForm;
  saved: ProductionLateForm;
  update: (patch: Partial<ProductionLateForm>) => void;
  settings: PayrollSettingsItem;
  branchLogin: boolean;
  readOnly: boolean;
  busy: boolean;
  onUseSharedClick: () => void;
}) {
  const info = CYCLE_INFO[cycle];
  const cycleForm = form.cycles[cycle];
  const errors = cycleLateErrors(cycleForm, saved.cycles[cycle]);
  const invalid = hasCycleLateErrors(errors);
  const own = cycleLateRules(settings, cycle).own;
  const sharedAllowance = settings.prodLateFreeAllowance ?? 3;
  const sharedSlabs = (settings.prodLateDeductionSlabs ?? []).length;
  const sharedWords = `${plural(sharedAllowance, "free late day")}, ${plural(sharedSlabs, "slab")}`;
  const pageLink = { where: `Production Payroll - ${info.label}`, to: info.path };

  const setCycle = (patch: Partial<ProductionLateForm["cycles"][PayCycle]>) =>
    update({ cycles: { ...form.cycles, [cycle]: { ...cycleForm, ...patch } } });

  const allowance = numberOr(
    cycleForm.lateFreeAllowance,
    RANGES.lateCount,
    numberOr(saved.cycles[cycle].lateFreeAllowance, RANGES.lateCount, 3),
  );
  const everyone = deductsFromEveryone(cycleForm.lateSlabs);
  const price = (lates: number) => productionLatePenalty(lates, allowance, cycleForm.lateSlabs, PER_SHIFT);

  return (
    <SettingsSection
      icon={CalendarRange}
      title={CYCLE_LATE_SECTIONS[cycle]}
      purpose={`What a late day costs a worker on the ${info.label} cycle, per ${info.days}-day period, priced in shifts of their own Salary Per Shift. The on/off switch and what counts as late are the same for every cycle (above). The pay period itself is set on Production Payroll.`}
      usedBy={[
        { label: `Production Payroll - ${info.label}`, to: info.path },
        { label: `${info.label} pay period`, to: `/hr/settings?tab=production_payroll#${cycle}-week-start` },
      ]}
      testId={`${cycle}-late-section`}
    >
      <div
        className={cn(
          "my-2 flex flex-wrap items-center justify-between gap-3 rounded-xl border px-3 py-2 text-xs leading-snug",
          own ? "border-blue-100 bg-blue-50/70 text-blue-900" : "border-slate-200 bg-slate-50 text-slate-700",
        )}
        data-testid={`${cycle}-late-source`}
      >
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="font-semibold">
            {own
              ? `${info.label} has late rules of its own.`
              : "Using the shared production values until you change them here."}
          </p>
          <p className="text-[11px] opacity-80">
            {own
              ? `The production-wide values saved before the cycles existed (${sharedWords}) are not used for ${info.label}.`
              : `Edit the free late days or the slabs below and save to give ${info.label} rules of its own; the other cycles keep theirs.`}
          </p>
        </div>
        {own && (
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            disabled={readOnly || busy}
            onClick={onUseSharedClick}
          >
            <Undo2 size={13} /> Use the shared rules again
          </Button>
        )}
      </div>

      <SettingBlock
        {...block(`${cycle}-late-allowance`)}
        labelFor={`${cycle}-late-allowance-input`}
        defaultText="the shared production value (3 a period unless it was changed)"
        affects={[
          {
            ...pageLink,
            what: "billable lates = late days in the period minus this; only billable lates are priced.",
          },
        ]}
        note={
          <>
            Per {info.days}-day period, not per month: a {info.label} worker gets {plural(allowance, "free late day")}{" "}
            {info.every}.
            {branchLogin &&
              " You are signed in to a branch: what you save here applies to your branch's employees only."}
          </>
        }
        preview={
          <PreviewCard scenario={`Late days in one ${info.label} period.`} testId={`${cycle}-allowance-preview`}>
            {[2, 4, 7].map((lates) => (
              <PreviewLine
                key={lates}
                label={`${lates} late days`}
                result={`${Math.min(lates, allowance)} free, ${price(lates).billable} billable`}
                tone={price(lates).billable > 0 ? "warn" : "good"}
              />
            ))}
          </PreviewCard>
        }
      >
        <NumberInput
          id={`${cycle}-late-allowance-input`}
          value={cycleForm.lateFreeAllowance}
          onChange={(v) => setCycle({ lateFreeAllowance: v })}
          unit="late days a period"
          error={errors.allowance}
          hint="0 to 366, a whole number."
          disabled={readOnly}
          className="w-24"
        />
      </SettingBlock>

      <SettingBlock
        {...block(`${cycle}-late-slabs`)}
        defaultText="the shared production rows (none unless they were added: lateness costs nothing)"
        affects={[
          {
            ...pageLink,
            what: "late penalty = the row's shifts x that worker's own Salary Per Shift, added to the period's deductions.",
          },
          {
            where: "Payslip and breakdown drawer",
            what: "show the late penalty and the number of billable lates.",
            to: info.path,
          },
        ]}
        note="No upper limit: a row can take more than a day's pay. A row starting at 0 billable lates charges every worker in the period, including those who were never late."
        preview={
          <SlabExample price={price} invalid={invalid} everyone={everyone} testId={`${cycle}-late-worked-example`} />
        }
      >
        <SlabTable
          slabs={cycleForm.lateSlabs}
          errors={errors.slabs}
          everyone={everyone}
          readOnly={readOnly}
          onChange={(rows) => setCycle({ lateSlabs: rows })}
          testId={`${cycle}-slab-table`}
        />
        <p className="text-[11px] text-gray-500">
          7 late days with the values above: {price(7).billable} billable, {cutText(price(7).shifts, price(7).penalty)}.
        </p>
        <p className="text-[11px] text-gray-500">
          The pay period of this cycle (week start, first period start) is on{" "}
          <TextLink to={`/hr/settings?tab=production_payroll#${cycle}-week-start`}>Production Payroll</TextLink>.
        </p>
      </SettingBlock>
    </SettingsSection>
  );
}
