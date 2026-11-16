import type { ComponentType, ReactNode } from "react";
import { ArrowDown, Clock3, Coffee, Moon, Pencil, Sun, TriangleAlert, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SettingsSection } from "../kit/SettingBlock";
import { PRODUCTION_SHIFT_SECTIONS } from "../ProductionShiftsTab.meta";
import { breakSpans, type GroupRow, type ShiftRulesDraft } from "./form";
import { ShiftTimeline, TimelineKey } from "./ShiftTimeline";
import { breakRangeText, breakTotals, groupSummary, type GroupSummary } from "./summary";
import { atText, spanText } from "./time";

const KIND_ICON: Record<GroupRow["kind"], ComponentType<{ size?: number; className?: string }>> = {
  day: Sun,
  night: Moon,
  sunday: Sun,
  custom: Users,
};

/** The id of a group's card in the editor below, and of its end-time box: the summary's buttons go there. */
export const groupCardId = (key: string) => `production-group-${key}`;
export const groupEndId = (key: string) => `production-group-${key}-end`;

/** Scroll to a group's card in the editor (and put the cursor in its end-time box when asked and it can be typed in). */
function goTo(key: string, focusEnd: boolean) {
  document.getElementById(groupCardId(key))?.scrollIntoView({ behavior: "smooth", block: "start" });
  if (!focusEnd) return;
  const box = document.getElementById(groupEndId(key));
  if (box instanceof HTMLInputElement && !box.disabled) box.focus({ preventScroll: true });
}

/** One "label: value" line of a card. */
function Fact({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="min-w-0" data-testid={testId}>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <div className="mt-0.5 text-[13px] leading-snug text-slate-700">{children}</div>
    </div>
  );
}

/** One group's card: its days, its hours From / To, the first-punch window, what the day pays, and the 24-hour bar. */
function GroupCard({ s, spans, readOnly }: { s: GroupSummary; spans: [number, number][]; readOnly: boolean }) {
  const Icon = KIND_ICON[s.kind];
  const last = s.points[s.points.length - 1];
  return (
    <article
      className={cn(
        "flex min-w-0 flex-col gap-3 rounded-xl border p-3.5 sm:p-4",
        s.enabled ? "border-slate-200 bg-white" : "border-dashed border-slate-300 bg-slate-50",
      )}
      data-testid="glance-card"
      data-kind={s.kind}
      data-enabled={s.enabled ? "true" : "false"}
      aria-label={`${s.name} at a glance`}
    >
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <span className="settings-tile h-8 w-8 shrink-0 rounded-lg">
          <Icon size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <h4 className="truncate text-sm font-semibold text-slate-900">{s.name}</h4>
          <p className="text-xs text-slate-500" data-testid="glance-days">
            {s.days}
          </p>
        </div>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[11px] font-semibold",
            s.enabled ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200" : "bg-slate-200 text-slate-600",
          )}
        >
          {s.enabled ? "In use" : "Off"}
        </span>
      </div>

      <Fact label="Shift time" testId="glance-range">
        <p className="text-[15px] font-semibold tabular-nums text-slate-900">{s.range ?? "Start time not set"}</p>
        {s.length && (
          <p className="text-xs text-slate-500">
            {s.length}
            {s.unpaid > 0 ? `, of which ${spanText(s.unpaid)} is unpaid break` : ""}
          </p>
        )}
      </Fact>

      {s.endSource !== "set" && (
        <div
          className="flex flex-wrap items-start gap-2 rounded-lg bg-amber-50 px-2.5 py-2 text-[12px] leading-snug text-amber-900 ring-1 ring-amber-200"
          data-testid="glance-no-end"
        >
          <TriangleAlert size={13} className="mt-0.5 shrink-0" />
          <span className="min-w-0 flex-1 basis-48">
            No end time is set for this shift
            {s.endSource === "last" && last
              ? `, so its last paid leaving time (${atText(last.at)}) is shown as the end. `
              : ". "}
            Set one so everybody can see when the shift ends; leaving before it is then flagged Left early.
          </span>
          {!readOnly && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 bg-white px-2 text-xs"
              data-view-safe
              data-testid="glance-set-end"
              onClick={() => goTo(s.key, true)}
            >
              Set an end time
            </Button>
          )}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Fact label="First punch" testId="glance-window">
          {s.window ?? "Window not complete"}
        </Fact>
        <Fact label="The day pays" testId="glance-pays">
          {s.pays}
        </Fact>
      </div>

      <ShiftTimeline
        start={s.start}
        end={s.end}
        extraEnd={s.endSource === "set" && last ? last.at : null}
        points={s.points}
        spans={spans}
        summary={`${s.name}: ${s.range ?? "no start time"}. ${s.pays}.`}
        testId="glance-timeline"
      />

      <div className="mt-auto">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 gap-1 px-2 text-xs text-[#006496]"
          data-view-safe
          onClick={() => goTo(s.key, false)}
        >
          {readOnly ? <ArrowDown size={12} /> : <Pencil size={12} />}
          {readOnly ? `See ${s.name}'s details` : `Change ${s.name}`}
        </Button>
      </div>
    </article>
  );
}

/**
 * "Shift timings at a glance": a card for every shift group with its hours as From / To, the first-punch window, what the
 * day pays at the end time and at most, and a 24-hour bar; then the unpaid breaks of every day and their total. It reads
 * the form on screen, so an edit below shows here at once (and says so while it is not saved).
 */
export function SummarySection({
  draft,
  dirty,
  readOnly,
}: {
  draft: ShiftRulesDraft;
  dirty: boolean;
  readOnly: boolean;
}) {
  const spans = breakSpans(draft.breaks);
  const cards = draft.groups.map((g, i) => groupSummary(g, draft.breaks, i));
  const totals = breakTotals(draft.breaks);
  const onBreaks = draft.breaks.filter((b) => b.enabled);

  return (
    <SettingsSection
      id="production-shifts-glance"
      icon={Clock3}
      title={PRODUCTION_SHIFT_SECTIONS.glance}
      purpose="When each shift starts and ends, when its first punch must be, what the day pays and where the unpaid breaks fall. Change any of it in the sections below."
      testId="production-shifts-glance"
    >
      <div className="space-y-4 pt-3">
        {dirty && (
          <p
            className="inline-flex rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-800 ring-1 ring-amber-200"
            data-testid="glance-unsaved"
          >
            Shows your changes, which are not saved yet
          </p>
        )}
        {cards.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-center text-xs text-gray-500">
            No shift groups yet: add one under Shift groups below.
          </p>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
            {cards.map((s) => (
              <GroupCard key={s.key} s={s} spans={spans} readOnly={readOnly} />
            ))}
          </div>
        )}

        <div className="rounded-xl border border-slate-200 bg-white p-3.5 sm:p-4" data-testid="glance-breaks">
          <div className="flex flex-wrap items-center gap-2">
            <span className="settings-tile h-8 w-8 shrink-0 rounded-lg">
              <Coffee size={15} />
            </span>
            <div className="min-w-0 flex-1">
              <h4 className="text-sm font-semibold text-slate-900">Breaks that are never paid</h4>
              <p className="text-xs text-slate-500" data-testid="glance-breaks-total">
                {totals.text}
              </p>
            </div>
          </div>
          {onBreaks.length > 0 && (
            <ul className="mt-3 flex flex-wrap gap-1.5">
              {onBreaks.map((b) => (
                <li
                  key={b.key}
                  className="rounded-lg bg-slate-50 px-2 py-1 text-[12px] text-slate-700 ring-1 ring-slate-200"
                >
                  <span className="font-semibold tabular-nums">{breakRangeText(b)}</span>
                  {b.label.trim() && <span className="text-slate-500"> · {b.label.trim()}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
        <TimelineKey />
      </div>
    </SettingsSection>
  );
}
