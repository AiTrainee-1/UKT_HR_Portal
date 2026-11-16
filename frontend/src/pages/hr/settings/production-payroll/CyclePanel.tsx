import { useState } from "react";
import { CalendarRange } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useListProductionPayroll, useProductionNextPeriod, type PayCycle } from "@/lib/api-client/custom-hooks";
import { PreviewCard, PreviewLine, SettingBlock, SettingsSection } from "../kit/SettingBlock";
import { CYCLE_SECTIONS, productionText } from "../ProductionPayrollTab.meta";
import { saveErrorText, type Draft } from "../payroll/form";
import type { Change } from "../payroll/sections";
import { ConfirmChanges, SelectInput, StickySave, TextLink } from "../payroll/ui";
import {
  CYCLE_INFO,
  formatDayLong,
  formatPeriod,
  nextCyclePeriod,
  normalizeWeekStart,
  parseIsoDay,
  periodDays,
  samePeriod,
  snapToWeekStart,
  weekRunsArrow,
  WEEK_START_NAME,
  WEEK_START_OPTIONS,
  type Day,
} from "./cycles";
import { CycleAtAGlance } from "./CycleCard";
import { cycleErrors, hasCycleErrors, latestGeneratedPeriod, type CycleForm } from "./sections";

const block = (id: string) => ({ id, ...productionText(id) });

/**
 * Settings -> Production Payroll -> Weekly / BiWeekly / Monthly: one pay cycle at a glance (the week it runs, the period
 * length, the first period start, the PF / ESI factor, the current and the next period and a strip of the periods after
 * it), then its period rule (which weekday its weeks start on, which date its periods are counted from), saved with one
 * button that sends only this cycle's period keys. What a late day costs on the cycle is not here: it is on Late
 * Detection -> Production, which saves the cycle's late keys (the server merges `prodCycles` key by key).
 */
export function CyclePanel({
  cycle,
  draft,
  saved,
  branchLogin,
  today,
  readOnly,
  saving,
  busy,
  onSave,
}: {
  cycle: PayCycle;
  draft: Draft<CycleForm>;
  saved: CycleForm;
  /** A branch login: its periods continue from its own branch's latest generated period. */
  branchLogin: boolean;
  today: Day;
  readOnly: boolean;
  saving: boolean;
  busy: boolean;
  onSave: () => Promise<void>;
}) {
  const info = CYCLE_INFO[cycle];
  const { form, set } = draft;
  const errors = cycleErrors(form);
  const invalid = hasCycleErrors(errors);
  const [confirming, setConfirming] = useState(false);
  const rule = { weekStart: form.weekStart, anchorDate: form.anchorDate };

  // The server's own next period for the SAVED rule, and the latest period generated on this cycle (what the engine
  // continues from). Both are counted per branch for a branch login (production_period.py last_generated_cycle_end with
  // the login's branch; the Production Payroll list is scoped the same way), so a branch login sees its own branch's.
  const serverNext = useProductionNextPeriod(cycle);
  const runs = useListProductionPayroll({ cycle, limit: 20 });
  const lastGenerated = runs.data ? latestGeneratedPeriod(runs.data, cycle) : undefined;
  const serverNextError = serverNext.isError
    ? (saveErrorText(serverNext.error) ?? "the saved rule is not complete")
    : null;
  const forBranch = branchLogin ? " for your branch" : "";
  // the server keeps the latest generated period as the next one while it is open (Payroll Done not pressed on it): when
  // its answer is that very period, the screen does the same
  const serverPeriod =
    serverNext.data && parseIsoDay(serverNext.data.periodStart) && parseIsoDay(serverNext.data.periodEnd)
      ? { start: parseIsoDay(serverNext.data.periodStart)!, end: parseIsoDay(serverNext.data.periodEnd)! }
      : null;
  const open = lastGenerated && serverPeriod && samePeriod(lastGenerated, serverPeriod) ? lastGenerated : null;

  const live = nextCyclePeriod(cycle, rule, lastGenerated?.end ?? null, today, open);
  const overlap = "error" in live ? null : live.overlap;
  const typedDate = parseIsoDay(form.anchorDate);
  const snapped = typedDate ? snapToWeekStart(typedDate, form.weekStart) : null;
  const dateMissing = info.needsDate && !form.anchorDate.trim();

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

  const save = () => (overlap ? setConfirming(true) : void onSave());
  const pageLink = { where: `Production Payroll - ${info.label}`, to: info.path };

  return (
    <div className="space-y-4">
      <SettingsSection
        icon={CalendarRange}
        title={CYCLE_SECTIONS[cycle].period}
        purpose={`Which dates one ${info.label} payslip covers: ${info.days} days, paid ${info.every}. Only employees assigned to the ${info.label} cycle are paid on it, once a period has ended. The card shows the values on screen; change them below.`}
        usedBy={[
          { label: `Production Payroll - ${info.label}`, to: info.path },
          { label: "Production Employees", to: "/hr/employees/productionEmployee" },
          { label: "Production Shift Register", to: "/hr/reports" },
        ]}
        testId={`${cycle}-period-section`}
      >
        <CycleAtAGlance
          cycle={cycle}
          rule={rule}
          lastGenerated={lastGenerated}
          open={open}
          checking={runs.isLoading}
          today={today}
          branchLogin={branchLogin}
        />
        {draft.dirty && (
          <p
            className="mt-2 inline-flex rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-800 ring-1 ring-amber-200"
            data-testid={`${cycle}-card-unsaved`}
          >
            The card shows your changes, which are not saved yet
          </p>
        )}

        <SettingBlock
          {...block(`${cycle}-week-start`)}
          labelFor={`${cycle}-week-start-input`}
          defaultText="Monday"
          className="mt-4 border-t pt-5 first:border-t"
          affects={[
            {
              ...pageLink,
              what: `every ${info.label} period is ${info.days} days starting on this weekday.`,
            },
          ]}
          note={
            lastGenerated
              ? `Periods already generated keep their dates. A new start weekday can make the next period start earlier and cover days already paid: the Next to generate card says when.`
              : undefined
          }
        >
          <SelectInput
            id={`${cycle}-week-start-input`}
            value={form.weekStart}
            onChange={(v) => set("weekStart", normalizeWeekStart(v))}
            disabled={readOnly}
            options={WEEK_START_OPTIONS}
          />
          <p className="text-[13px] font-semibold text-slate-800" data-testid={`${cycle}-week-runs-line`}>
            Week runs {weekRunsArrow(form.weekStart)}
          </p>
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
                  ? runs.isError
                    ? `Worked out from the values on screen, starting from today (${formatDayLong(today)}): the latest generated period could not be read.`
                    : "Worked out from the values on screen..."
                  : lastGenerated
                    ? `Worked out from the values on screen. Latest ${info.label} period generated${forBranch}: ${formatPeriod(lastGenerated)}.`
                    : `Worked out from the values on screen. No ${info.label} period has been generated yet${forBranch}, so the first is the most recent period that has ended.`
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
                      result="draft payslips there are replaced when the new periods are generated; finalized or paid ones never"
                    />
                  )}
                  <PreviewLine
                    label="Can be generated"
                    result={
                      live.stillOpen
                        ? "it is generated and still open (until Payroll Done)"
                        : live.ended
                          ? "now (it has ended)"
                          : `from ${formatDayLong(live.generateFrom)}, the day after its last day`
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

      <p className="px-1 text-[12px] leading-snug text-slate-500" data-testid={`${cycle}-late-pointer`}>
        What a late day costs a {info.label} worker (free late days and deduction slabs) is on{" "}
        <TextLink to={`/hr/settings?tab=late_detection#${cycle}-late-allowance`}>
          Late Detection - Production - {info.label}
        </TextLink>
        .
      </p>

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
        open={confirming}
        onOpenChange={setConfirming}
        title={`This ${info.label} rule covers days already generated`}
        changes={changes}
        confirmLabel="Save anyway"
        onConfirm={() => void onSave()}
      >
        {overlap && !("error" in live) && (
          <p className="text-red-700">
            The next {info.label} period becomes {formatPeriod(live.period)}, but {info.label} payroll is already
            generated up to {formatDayLong(overlap.end)}. Payslips of {formatPeriod(overlap)} that are only Generated
            (drafts) are replaced when the new periods are generated, so those days are paid once, in the new periods;
            payslips of a finalized (Payroll Done) or paid period are never replaced, and their days stay paid. Check
            the {info.label} payroll page before generating, or choose values that make the next period start on{" "}
            {formatDayLong(overlap.end)} plus one day.
          </p>
        )}
        {branchLogin && <p>You are signed in to a branch: this applies to your branch's employees only.</p>}
      </ConfirmChanges>
    </div>
  );
}
