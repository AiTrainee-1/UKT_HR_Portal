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
  resolveCyclePeriod,
  snapToWeekStart,
  WEEK_START_NAME,
  WEEK_START_OPTIONS,
  type Day,
} from "./cycles";
import { cycleErrors, hasCycleErrors, latestGeneratedPeriod, type CycleForm } from "./sections";

const block = (id: string) => ({ id, ...productionText(id) });

/**
 * Settings -> Production Payroll -> Weekly / BiWeekly / Monthly: one pay cycle's period rule (which weekday its weeks
 * start on, which date its periods are counted from), saved with one button that sends only this cycle's period keys.
 * What a late day costs on the cycle is not here: it is on Late Detection -> Production, which saves the cycle's late keys
 * (the server merges `prodCycles` key by key, so neither save overwrites the other).
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
  /** A branch login cannot read the company-wide pointer (the latest generated period). */
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
            generated up to {formatDayLong(overlap.end)}: workers already paid for {formatPeriod(overlap)} are skipped
            for that period. Check the {info.label} payroll page before generating, or choose values that make the next
            period start on {formatDayLong(overlap.end)} plus one day.
          </p>
        )}
        {branchLogin && <p>You are signed in to a branch: this applies to your branch's employees only.</p>}
      </ConfirmChanges>
    </div>
  );
}
