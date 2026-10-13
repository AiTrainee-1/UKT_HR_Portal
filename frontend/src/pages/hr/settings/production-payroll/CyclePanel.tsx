import { useState } from "react";
import { AlertTriangle, CalendarRange, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useListProductionPayroll, useProductionNextPeriod, type PayCycle } from "@/lib/api-client/custom-hooks";
import { PreviewCard, PreviewLine, SettingBlock, SettingsSection } from "../kit/SettingBlock";
import { CYCLE_SECTIONS, productionText } from "../ProductionPayrollTab.meta";
import { numberOr, RANGES, saveErrorText, type Draft } from "../payroll/form";
import type { Change } from "../payroll/sections";
import { ConfirmChanges, NumberInput, SelectInput, StickySave } from "../payroll/ui";
import {
  CYCLE_INFO,
  formatDayLong,
  formatPeriod,
  nextCyclePeriod,
  normalizeWeekStart,
  parseIsoDay,
  periodDays,
  resolveCyclePeriod,
  snapToWeekStart,
  WEEK_START_NAME,
  WEEK_START_OPTIONS,
  type Day,
} from "./cycles";
import { productionLatePenalty } from "./preview";
import {
  cycleErrors,
  deductsFromEveryone,
  hasCycleErrors,
  lateKeysChanged,
  latestGeneratedPeriod,
  type CycleForm,
} from "./sections";
import { cutText, PER_SHIFT, SlabExample, SlabTable } from "./SlabEditor";

const block = (id: string) => ({ id, ...productionText(id) });

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Settings -> Production Payroll -> Weekly / BiWeekly / Monthly: one pay cycle's period rule (which weekday its weeks
 * start on, which date its periods are counted from) and its own late deductions, saved together with one button that
 * sends only this cycle. The period rule always goes; the late values go only when changed, so saving a period never
 * silently takes the shared late rules away from the cycle.
 */
export function CyclePanel({
  cycle,
  draft,
  saved,
  ownRules,
  shared,
  branchLogin,
  today,
  readOnly,
  saving,
  busy,
  onSave,
  onUseShared,
}: {
  cycle: PayCycle;
  draft: Draft<CycleForm>;
  saved: CycleForm;
  /** The cycle has late rules of its own (false: it follows the shared production values). */
  ownRules: boolean;
  /** The shared production late values, for the words of "Use the shared rules again". */
  shared: { allowance: number; slabCount: number };
  /** A branch login cannot read the company-wide pointer (the latest generated period). */
  branchLogin: boolean;
  today: Day;
  readOnly: boolean;
  saving: boolean;
  busy: boolean;
  onSave: () => Promise<void>;
  onUseShared: () => Promise<void>;
}) {
  const info = CYCLE_INFO[cycle];
  const { form, set } = draft;
  const errors = cycleErrors(form, saved);
  const invalid = hasCycleErrors(errors);
  const [confirming, setConfirming] = useState<"save" | "shared" | null>(null);
  const rule = { weekStart: form.weekStart, anchorDate: form.anchorDate };

  // The server's own next period for the SAVED rule, and the latest period generated on this cycle (what the engine
  // continues from). The Production Payroll list is scoped to a branch login's branch while that pointer is
  // company-wide, so a branch login is told it is not known rather than shown a wrong one.
  const serverNext = useProductionNextPeriod(cycle);
  const runs = useListProductionPayroll({ cycle, limit: 20 }, { enabled: !branchLogin });
  const lastGenerated = branchLogin || !runs.data ? undefined : latestGeneratedPeriod(runs.data, cycle);
  const serverNextError = serverNext.isError
    ? (saveErrorText(serverNext.error) ?? "the saved rule is not complete")
    : null;

  const around = resolveCyclePeriod(today, cycle, rule);
  const live = nextCyclePeriod(cycle, rule, lastGenerated?.end ?? null, today);
  const overlap = "error" in live ? null : live.overlap;
  const typedDate = parseIsoDay(form.anchorDate);
  const snapped = typedDate ? snapToWeekStart(typedDate, form.weekStart) : null;
  const dateMissing = info.needsDate && !form.anchorDate.trim();

  const allowance = numberOr(
    form.lateFreeAllowance,
    RANGES.lateCount,
    numberOr(saved.lateFreeAllowance, RANGES.lateCount, 3),
  );
  const everyone = deductsFromEveryone(form.lateSlabs);
  const price = (lates: number) => productionLatePenalty(lates, allowance, form.lateSlabs, PER_SHIFT);
  const lateChanged = lateKeysChanged(draft.changed);
  const sharedWords = `${plural(shared.allowance, "free late day")}, ${plural(shared.slabCount, "slab")}`;

  const changes: Change[] = [];
  if (draft.changed.includes("weekStart")) {
    changes.push({
      label: "Week starts on",
      from: WEEK_START_NAME[normalizeWeekStart(saved.weekStart)],
      to: WEEK_START_NAME[normalizeWeekStart(form.weekStart)],
    });
  }
  if (draft.changed.includes("anchorDate")) {
    const words = (iso: string) => {
      const d = parseIsoDay(iso);
      return d ? formatDayLong(d) : "(not set)";
    };
    changes.push({ label: "First period starts on", from: words(saved.anchorDate), to: words(form.anchorDate) });
  }
  if (draft.changed.includes("lateFreeAllowance")) {
    changes.push({ label: "Free late days a period", from: saved.lateFreeAllowance, to: form.lateFreeAllowance });
  }
  if (draft.changed.includes("lateSlabs")) {
    changes.push({
      label: "Deduction slabs",
      from: plural(saved.lateSlabs.length, "row"),
      to: `${plural(form.lateSlabs.length, "row")}, edited`,
    });
  }

  const save = () => (lateChanged || overlap ? setConfirming("save") : void onSave());
  const pageLink = { where: `Production Payroll - ${info.label}`, to: info.path };

  return (
    <div className="space-y-4">
      <SettingsSection
        icon={CalendarRange}
        title={CYCLE_SECTIONS[cycle].period}
        purpose={`Which dates one ${info.label} payslip covers: ${info.every}, in ${info.weeks === 1 ? "one whole week" : `${info.weeks} whole weeks`} (${info.days} days). Only employees assigned to the ${info.label} cycle are paid on it; each period is generated on the ${info.label} payroll page once it has ended.`}
        usedBy={[
          { label: `Production Payroll - ${info.label}`, to: info.path },
          { label: "Production Employees", to: "/hr/employees/productionEmployee" },
          { label: "Production Shift Register", to: "/hr/reports" },
        ]}
        testId={`${cycle}-period-section`}
      >
        <SettingBlock
          {...block(`${cycle}-week-start`)}
          labelFor={`${cycle}-week-start-input`}
          defaultText="Monday"
          affects={[
            {
              ...pageLink,
              what: `every ${info.label} period is ${info.days} days starting on this weekday; the page offers the periods accordingly.`,
            },
            {
              where: "Production Shift Register report",
              what: "notes the production pay period.",
              to: "/hr/reports",
            },
          ]}
          note={
            lastGenerated
              ? `Periods already generated keep their dates. ${info.label} payroll continues from the day after its latest generated period, so a new start weekday can make the next period start earlier and cover days already paid: the Next period example says when.`
              : undefined
          }
          preview={
            <PreviewCard scenario="The pay period holding today, with these values." testId={`${cycle}-today-preview`}>
              {"period" in around ? (
                <PreviewLine
                  label="This period"
                  result={`${formatDayLong(around.period.start)} to ${formatDayLong(around.period.end)}`}
                />
              ) : (
                <PreviewLine tone="warn" label="Not known yet" result="set the first period start below" />
              )}
            </PreviewCard>
          }
        >
          <SelectInput
            id={`${cycle}-week-start-input`}
            value={form.weekStart}
            onChange={(v) => set("weekStart", normalizeWeekStart(v))}
            disabled={readOnly}
            options={WEEK_START_OPTIONS}
          />
        </SettingBlock>

        <SettingBlock
          {...block(`${cycle}-first-period`)}
          labelFor={`${cycle}-first-period-input`}
          defaultText="not set"
          affects={[
            {
              ...pageLink,
              what: info.needsDate
                ? "every period boundary from now on; changing it moves them all. Without it the page cannot generate."
                : "nothing: Weekly periods follow the start weekday alone, with or without a date.",
            },
          ]}
          note={
            info.needsDate
              ? `Periods already generated keep their dates. Choose a ${WEEK_START_NAME[normalizeWeekStart(form.weekStart)]} a real ${info.label} period began on, so the periods line up with the ones already paid.`
              : undefined
          }
          preview={
            <PreviewCard
              title="Next period"
              scenario={
                lastGenerated === undefined
                  ? `Worked out from the values on screen, starting from today (${formatDayLong(today)}): the latest generated period could not be read with this login.`
                  : lastGenerated
                    ? `Worked out from the values on screen. Latest ${info.label} period generated: ${formatPeriod(lastGenerated)}.`
                    : `Worked out from the values on screen. No ${info.label} period has been generated yet, so the first is the most recent period that has ended.`
              }
              testId={`${cycle}-next-period-preview`}
            >
              {snapped && typedDate && (
                <PreviewLine
                  label={`First period start ${formatDayLong(typedDate)}`}
                  result={
                    snapped.day === typedDate.day && snapped.month === typedDate.month
                      ? "already on the start weekday"
                      : `moved back to ${formatDayLong(snapped)}`
                  }
                />
              )}
              {"error" in live ? (
                <PreviewLine tone="warn" label="Not a complete rule yet" result={live.error} />
              ) : (
                <>
                  <PreviewLine
                    tone={overlap ? "bad" : "info"}
                    label="Next period to generate"
                    result={`${formatPeriod(live.period)} (${periodDays(live.period)} days)`}
                  />
                  {overlap && (
                    <PreviewLine
                      tone="bad"
                      label={`${formatPeriod(overlap)} is already generated`}
                      result="workers paid for those days are skipped"
                    />
                  )}
                  <PreviewLine
                    label="Can be generated"
                    result={
                      live.ended ? "now (it has ended)" : `from ${formatDayLong(live.generateFrom)}, its last day`
                    }
                  />
                  <PreviewLine label="Then" result={live.then.map(formatPeriod).join(", ")} />
                </>
              )}
              <PreviewLine
                label={`With the saved settings, the ${info.label} payroll page says`}
                result={
                  serverNext.data
                    ? `${serverNext.data.periodStart} to ${serverNext.data.periodEnd}${serverNext.data.periodEnded ? " (ended)" : " (not ended yet)"}`
                    : (serverNextError ?? "...")
                }
              />
            </PreviewCard>
          }
        >
          <div className="space-y-1">
            <Input
              id={`${cycle}-first-period-input`}
              type="date"
              value={form.anchorDate}
              disabled={readOnly}
              onChange={(e) => set("anchorDate", e.target.value)}
              aria-invalid={errors.anchorDate ? true : undefined}
              className="w-44"
            />
            {errors.anchorDate ? (
              <p role="alert" className="text-xs font-medium text-red-600">
                {errors.anchorDate}
              </p>
            ) : dateMissing ? (
              <p
                className="rounded-lg bg-red-50 px-2.5 py-1.5 text-xs font-medium text-red-800"
                data-testid={`${cycle}-date-missing`}
              >
                Not set: {info.label} payroll cannot be generated until you choose it.
              </p>
            ) : (
              <p className="text-xs text-gray-500">
                {info.needsDate
                  ? "Any date works: it is moved back to the start weekday."
                  : "Optional: Weekly periods are the same with or without it."}
              </p>
            )}
          </div>
        </SettingBlock>
      </SettingsSection>

      <SettingsSection
        icon={AlertTriangle}
        title={CYCLE_SECTIONS[cycle].late}
        purpose={`What a late day costs a worker on the ${info.label} cycle, per ${info.days}-day period, priced in shifts of their own Salary Per Shift. The on/off switch and what counts as late are the same for every cycle: they are on the Late Detection sub-tab.`}
        usedBy={[
          { label: `Production Payroll - ${info.label}`, to: info.path },
          { label: "Late Detection sub-tab", to: "/hr/settings?tab=production_payroll#prod-late-switch" },
        ]}
        testId={`${cycle}-late-section`}
      >
        <div
          className={cn(
            "my-2 flex flex-wrap items-center justify-between gap-3 rounded-xl border px-3 py-2 text-xs leading-snug",
            ownRules ? "border-blue-100 bg-blue-50/70 text-blue-900" : "border-slate-200 bg-slate-50 text-slate-700",
          )}
          data-testid={`${cycle}-late-source`}
        >
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="font-semibold">
              {ownRules
                ? `${info.label} has late rules of its own.`
                : "Using the shared production values until you change them here."}
            </p>
            <p className="text-[11px] opacity-80">
              {ownRules
                ? `The production-wide values saved before the cycles existed (${sharedWords}) are not used for ${info.label}.`
                : `Edit the free late days or the slabs below and save to give ${info.label} rules of its own; the other cycles keep theirs.`}
            </p>
          </div>
          {ownRules && (
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              disabled={readOnly || busy}
              onClick={() => setConfirming("shared")}
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
            value={form.lateFreeAllowance}
            onChange={(v) => set("lateFreeAllowance", v)}
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
            slabs={form.lateSlabs}
            errors={errors.slabs}
            everyone={everyone}
            readOnly={readOnly}
            onChange={(rows) => set("lateSlabs", rows)}
            testId={`${cycle}-slab-table`}
          />
          <p className="text-[11px] text-gray-500">
            7 late days with the values above: {price(7).billable} billable,{" "}
            {cutText(price(7).shifts, price(7).penalty)}.
          </p>
        </SettingBlock>
      </SettingsSection>

      <StickySave
        dirty={draft.dirty}
        saving={saving}
        onSave={save}
        onDiscard={draft.discard}
        saveLabel={`Save ${info.label} settings`}
        disabled={readOnly || invalid || busy}
        hint={invalid ? "Fix the values marked in red first." : undefined}
      />

      <ConfirmChanges
        open={confirming === "save"}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={overlap ? `This ${info.label} rule covers days already generated` : `Save the ${info.label} settings?`}
        changes={changes}
        confirmLabel={overlap ? "Save anyway" : "Save changes"}
        onConfirm={() => void onSave()}
      >
        {overlap && !("error" in live) && (
          <p className="text-red-700">
            The next {info.label} period becomes {formatPeriod(live.period)}, but {info.label} payroll is already
            generated up to {formatDayLong(overlap.end)}: workers already paid for {formatPeriod(overlap)} are skipped
            for that period. Check the {info.label} payroll page before generating, or choose values that make the next
            period start on {formatDayLong(overlap.end)} plus one day.
          </p>
        )}
        {lateChanged && (
          <p>
            {info.label} payslips generated from now on use these late rules, backfilled past periods included. Payslips
            already generated keep their late deduction until their period is generated again.
          </p>
        )}
        {lateChanged && !ownRules && (
          <p>
            {info.label} stops following the shared production values ({sharedWords}) and keeps these as its own; the
            other cycles are not affected.
          </p>
        )}
        {everyone && (
          <p className="text-red-700">A slab starts at 0: every worker in a period is charged, late or not.</p>
        )}
        {branchLogin && <p>You are signed in to a branch: these rules apply to your branch's employees only.</p>}
      </ConfirmChanges>

      <ConfirmChanges
        open={confirming === "shared"}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={`Use the shared late rules for ${info.label} again?`}
        changes={[
          { label: "Free late days a period", from: saved.lateFreeAllowance, to: String(shared.allowance) },
          {
            label: "Deduction slabs",
            from: plural(saved.lateSlabs.length, "row"),
            to: plural(shared.slabCount, "row"),
          },
        ]}
        confirmLabel="Use the shared rules"
        onConfirm={() => void onUseShared()}
      >
        <p>
          {info.label} goes back to the production-wide values saved before the cycles existed ({sharedWords}) and
          follows them from now on. Payslips already generated keep their late deduction; any unsaved edits to these two
          settings are dropped.
        </p>
      </ConfirmChanges>
    </div>
  );
}
