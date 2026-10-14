import { useState } from "react";
import { AlertTriangle, Layers } from "lucide-react";
import type { PayrollSettingsItem, ShiftTemplate } from "@/lib/api-client/custom-hooks";
import { PreviewCard, PreviewLine, SettingBlock, SettingsSection } from "../kit/SettingBlock";
import { ToggleField } from "../kit/Field";
import { PRODUCTION_SECTIONS, productionText } from "../ProductionPayrollTab.meta";
import type { Draft } from "../payroll/form";
import { formatPaise } from "../payroll/preview";
import type { Change } from "../payroll/sections";
import { ConfirmChanges, SelectInput, StickySave, TextLink } from "../payroll/ui";
import { CYCLE_INFO, CYCLES } from "./cycles";
import { judgeProductionDay, productionLatePenalty } from "./preview";
import { cycleLateRules, type LateForm } from "./sections";
import { cutText, PER_SHIFT } from "./SlabEditor";

const block = (id: string) => ({ id, ...productionText(id) });

/** The example shift when Manage Shifts has no production shift with times (the inventory's example). */
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
 * Settings -> Production Payroll -> "Late Detection": the global production late pool (the switch and what counts as
 * late), the same for every pay cycle, separate from the staff pool. The free allowance and the slabs are per cycle,
 * on the cycle sub-tabs; this panel shows each cycle's and links there.
 */
export function LatePanel({
  draft,
  saved,
  settings,
  shifts,
  branchLogin,
  readOnly,
  saving,
  busy,
  onSave,
}: {
  draft: Draft<LateForm>;
  saved: LateForm;
  /** The saved settings: each cycle's late rules price the switch example. */
  settings: PayrollSettingsItem;
  /** The shifts of Manage Shifts: the first active production shift with times is the example's shift. */
  shifts: ShiftTemplate[] | undefined;
  branchLogin: boolean;
  readOnly: boolean;
  saving: boolean;
  busy: boolean;
  onSave: () => Promise<void>;
}) {
  const { form, set } = draft;
  const [confirming, setConfirming] = useState(false);

  const rules = CYCLES.map((cycle) => ({ cycle, ...CYCLE_INFO[cycle], ...cycleLateRules(settings, cycle) }));
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

  const changes: Change[] = [];
  if (draft.changed.includes("enabled")) {
    changes.push({ label: "Late deductions", from: saved.enabled ? "On" : "Off", to: form.enabled ? "On" : "Off" });
  }
  if (draft.changed.includes("mode")) {
    changes.push({
      label: "What counts as late",
      from: MODE_NAME[saved.mode] ?? saved.mode,
      to: MODE_NAME[form.mode] ?? form.mode,
    });
  }

  const cyclePages = CYCLES.map((cycle) => ({
    label: `Production Payroll - ${CYCLE_INFO[cycle].label}`,
    to: CYCLE_INFO[cycle].path,
  }));

  return (
    <div className="space-y-4">
      <SettingsSection
        icon={AlertTriangle}
        title={PRODUCTION_SECTIONS.late}
        purpose="Whether a late day costs a production worker pay, and what makes a day late, on every pay cycle. Off by default. This is not the staff Late Detection tab: it counts per pay period (not per month), has no permission pool, and is priced in shifts of each worker's own Salary Per Shift."
        usedBy={cyclePages}
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
            onChange={(v) => set("enabled", v)}
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
          note="Punches are compared to the second: 08:10:20 is late against a deadline of 08:10. The staff Attendance tab has its own Strict / Simple setting, which does not apply to production."
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
            onChange={(v) => set("mode", v)}
            disabled={readOnly}
            className="max-w-xs"
            options={[
              { value: "strict", label: "Strict - late arrival or early leaving" },
              { value: "simple", label: "Simple - late arrival only" },
            ]}
          />
        </SettingBlock>
      </SettingsSection>

      <SettingsSection
        icon={Layers}
        title={PRODUCTION_SECTIONS.perCycle}
        purpose="A period is a week, two weeks or four weeks long, so the free late days and the deduction slabs belong to each pay cycle, on its own sub-tab. A cycle uses the shared production values until it is given rules of its own."
        testId="production-late-per-cycle"
      >
        <ul className="mt-3 grid gap-2 md:grid-cols-3">
          {rules.map((r) => (
            <li
              key={r.cycle}
              className="space-y-1 rounded-xl bg-white p-3 text-[12px] leading-snug text-gray-700 ring-1 ring-slate-100"
              data-testid={`production-late-cycle-${r.cycle}`}
            >
              <p className="text-[13px] font-bold text-gray-900">
                {r.label} <span className="font-normal text-gray-400">({r.days} days)</span>
              </p>
              <p>
                {plural(r.allowance, "free late day")} a period, {plural(r.slabs.length, "slab")}
                <span className="text-gray-400"> - {r.own ? "its own rules" : "the shared values"}</span>
              </p>
              <TextLink to={`/hr/settings?tab=production_payroll#${r.cycle}-late-allowance`}>
                Open {r.label} late deductions
              </TextLink>
            </li>
          ))}
        </ul>
      </SettingsSection>

      <StickySave
        dirty={draft.dirty}
        saving={saving}
        onSave={() => (draft.dirty ? setConfirming(true) : void onSave())}
        onDiscard={draft.discard}
        saveLabel="Save Production Late Detection"
        disabled={readOnly || busy}
      />

      <ConfirmChanges
        open={confirming}
        onOpenChange={setConfirming}
        title="Save the production late detection?"
        changes={changes}
        confirmLabel="Save changes"
        onConfirm={() => void onSave()}
      >
        <p>
          Production payslips generated from now on, on every cycle, use it, backfilled past periods included. Payslips
          already generated keep their late deduction until their period is generated again.
        </p>
        {branchLogin && <p>You are signed in to a branch: this applies to your branch's employees only.</p>}
      </ConfirmChanges>
    </div>
  );
}
