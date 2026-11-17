import { useState } from "react";
import { CalendarClock, CalendarDays, CalendarRange, Check, Clock, Plus, Repeat, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { NOTIFY_CATEGORIES, NOTIFY_CHANNELS, type NotifyChannel } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import {
  CATEGORY_META,
  CHANNEL_LABEL,
  CONTENT_LABEL,
  MAX_RANGE_DAYS,
  MAX_TIMES,
  NAME_MAX,
  WEEKDAYS,
  addTime,
  dateSpanDays,
  nextRuns,
  removeTime,
  timeLabel,
  toggleDay,
  whenText,
  type NotifyDraft,
  type Problem,
} from "./logic";
import { CHANNEL_META, EMPLOYEE_TYPE_OPTIONS, Field, Segmented, ToggleRow } from "./parts";

type StepProps = {
  draft: NotifyDraft;
  onChange: (patch: Partial<NotifyDraft>) => void;
  /** The problems to show (only after the step was tried). */
  problems: Problem[];
};

const problemOf = (problems: Problem[], ...fields: string[]) =>
  problems.find((p) => fields.includes(p.field))?.message ?? null;

const QUICK_TIMES = ["09:30", "13:00", "18:00"];

// ─── step 1: the report ────────────────────────────────────────────────────────────────────────────────────────────

export function ReportStep({
  draft,
  onChange,
  problems,
  channelLocked,
}: StepProps & {
  /** An automation that exists keeps its channel (its recipients belong to it). */
  channelLocked: boolean;
}) {
  const span = dateSpanDays(draft.dateFrom, draft.dateTo || draft.dateFrom);
  const allCats = draft.categories.length === NOTIFY_CATEGORIES.length;
  return (
    <div className="space-y-5" data-testid="an-step-report">
      <Field
        label="Name"
        htmlFor="an-name"
        error={problemOf(problems, "name")}
        hint="Shown in the lists and the history."
      >
        <Input
          id="an-name"
          value={draft.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="e.g. Morning absentees to HR"
          maxLength={NAME_MAX}
          autoFocus
          data-testid="an-name"
        />
      </Field>

      {!channelLocked && (
        <Field label="Send through" hint="Each channel has its own recipients on the Recipients step.">
          <div className="grid gap-2 sm:grid-cols-3" role="group" aria-label="Channel" data-testid="an-channel-pick">
            {NOTIFY_CHANNELS.map((c: NotifyChannel) => {
              const meta = CHANNEL_META[c];
              const Icon = meta.icon;
              const on = draft.channel === c;
              return (
                <button
                  key={c}
                  type="button"
                  aria-pressed={on}
                  onClick={() => onChange({ channel: c })}
                  className={cn(
                    "flex items-center gap-2 rounded-xl border px-3 py-2.5 text-left text-sm font-semibold transition-colors",
                    on ? meta.soft : "border-slate-200 bg-white text-slate-700 hover:border-slate-300",
                  )}
                  data-view-safe
                  data-testid={`an-channel-pick-${c}`}
                >
                  <Icon size={15} /> {CHANNEL_LABEL[c]}
                  {on && <Check size={14} className="ml-auto" />}
                </button>
              );
            })}
          </div>
        </Field>
      )}

      <Field label="Report about" error={problemOf(problems, "dateFrom", "dateTo")}>
        <div className="space-y-3">
          <Segmented
            options={[
              { value: "daily", label: "Daily", icon: Repeat },
              { value: "custom", label: "Custom dates", icon: CalendarRange },
            ]}
            value={draft.reportType}
            onChange={(reportType) => onChange({ reportType })}
            ariaLabel="Report type"
            testId="an-report-type"
          />
          {draft.reportType === "daily" ? (
            <div className="space-y-1.5">
              <Segmented
                options={[
                  { value: "today", label: "Today" },
                  { value: "yesterday", label: "Yesterday" },
                ]}
                value={draft.reportDay}
                onChange={(reportDay) => onChange({ reportDay })}
                ariaLabel="Which day"
                testId="an-report-day"
                size="sm"
              />
              <p className="text-[11px] text-slate-500">
                Counted from the day it is sent: a send on Tuesday reports{" "}
                {draft.reportDay === "today" ? "Tuesday (so far)" : "Monday"}.
              </p>
            </div>
          ) : (
            <div className="flex flex-wrap items-end gap-3">
              <label className="space-y-1">
                <span className="block text-[11px] text-slate-500">From</span>
                <Input
                  type="date"
                  value={draft.dateFrom ?? ""}
                  onChange={(e) => onChange({ dateFrom: e.target.value || null })}
                  className="h-9 w-44"
                  data-testid="an-date-from"
                />
              </label>
              <label className="space-y-1">
                <span className="block text-[11px] text-slate-500">To (leave empty for one day)</span>
                <Input
                  type="date"
                  value={draft.dateTo ?? ""}
                  min={draft.dateFrom ?? undefined}
                  onChange={(e) => onChange({ dateTo: e.target.value || null })}
                  className="h-9 w-44"
                  data-testid="an-date-to"
                />
              </label>
              {span !== null && (
                <span
                  className={cn("pb-2 text-xs font-medium", span > MAX_RANGE_DAYS ? "text-red-600" : "text-slate-500")}
                >
                  {span} day{span === 1 ? "" : "s"} (at most {MAX_RANGE_DAYS})
                </span>
              )}
            </div>
          )}
        </div>
      </Field>

      <Field label="Categories" error={problemOf(problems, "categories")}>
        <div
          className="flex flex-wrap items-center gap-1.5"
          role="group"
          aria-label="Categories"
          data-testid="an-categories"
        >
          {NOTIFY_CATEGORIES.map((c) => {
            const on = draft.categories.includes(c);
            return (
              <button
                key={c}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  onChange({
                    categories: on
                      ? draft.categories.filter((x) => x !== c)
                      : NOTIFY_CATEGORIES.filter((x) => x === c || draft.categories.includes(x)),
                  })
                }
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors",
                  on
                    ? `${CATEGORY_META[c].tile} border-current`
                    : "border-slate-200 bg-white text-slate-500 hover:border-slate-300",
                )}
                data-view-safe
                data-testid={`an-category-${c}`}
              >
                {on ? <Check size={12} /> : <Plus size={12} />}
                {CATEGORY_META[c].label}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => onChange({ categories: allCats ? [] : [...NOTIFY_CATEGORIES] })}
            className="ml-1 text-xs font-semibold text-blue-700 hover:underline"
            data-view-safe
            data-testid="an-categories-all"
          >
            {allCats ? "Clear" : "Pick all five"}
          </button>
        </div>
      </Field>

      <div className="grid gap-5 md:grid-cols-2">
        <Field label="Employees" hint="Staff and Production are reported apart when you pick one; All covers both.">
          <Segmented
            options={EMPLOYEE_TYPE_OPTIONS}
            value={draft.employeeType}
            onChange={(employeeType) => onChange({ employeeType })}
            ariaLabel="Employee type"
            testId="an-employee-type"
          />
        </Field>
        <Field label="Content" hint={CONTENT_HINT[draft.content]}>
          <Segmented
            options={[
              { value: "summary", label: "Summary" },
              { value: "detailed", label: "Detailed list" },
              { value: "both", label: "Both" },
            ]}
            value={draft.content}
            onChange={(content) => onChange({ content })}
            ariaLabel="Content"
            testId="an-content"
          />
        </Field>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <ToggleRow
          id="an-photos"
          label="Include employee photos"
          hint={
            draft.content === "summary"
              ? "Only for a detailed list."
              : "Profile pictures next to each name in the detailed list."
          }
        >
          <Switch
            id="an-photos"
            checked={draft.includePhotos && draft.content !== "summary"}
            disabled={draft.content === "summary"}
            onCheckedChange={(includePhotos) => onChange({ includePhotos })}
            data-testid="an-photos"
          />
        </ToggleRow>
        <ToggleRow id="an-skip" label="Skip when empty" hint="Send nothing when nobody is in the chosen categories.">
          <Switch
            id="an-skip"
            checked={draft.skipWhenEmpty}
            onCheckedChange={(skipWhenEmpty) => onChange({ skipWhenEmpty })}
            data-testid="an-skip"
          />
        </ToggleRow>
      </div>
    </div>
  );
}

const CONTENT_HINT: Record<NotifyDraft["content"], string> = {
  summary: `${CONTENT_LABEL.summary}: how many people are in each category.`,
  detailed: `${CONTENT_LABEL.detailed}: one line per person (name, code, department, what it was).`,
  both: "The counts first, then one line per person.",
};

// ─── step 2: the schedule ──────────────────────────────────────────────────────────────────────────────────────────

/** The sending times: chips with a remove button, a time box (typed or picked) and quick picks. */
export function TimesEditor({
  times,
  onChange,
  error,
}: {
  times: string[];
  onChange: (times: string[]) => void;
  error: string | null;
}) {
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const full = times.length >= MAX_TIMES;
  const add = (raw: string) => {
    const next = addTime(times, raw);
    setProblem(next.error);
    if (!next.error) {
      onChange(next.times);
      setDraft("");
    }
  };
  return (
    <Field
      label={`Sending times (${times.length} of ${MAX_TIMES}, India time)`}
      error={problem ?? error}
      hint="Each time is sent once a day at most, even after a restart."
      testId="an-times"
    >
      {times.length > 0 ? (
        <ul className="flex flex-wrap gap-2" data-testid="an-times-list">
          {times.map((t) => (
            <li
              key={t}
              className="inline-flex items-center gap-1 rounded-full border border-blue-200 bg-blue-50 py-1 pl-3 pr-1 text-sm font-semibold text-blue-800"
            >
              <Clock size={13} aria-hidden />
              {timeLabel(t)}
              <button
                type="button"
                onClick={() => onChange(removeTime(times, t))}
                aria-label={`Remove ${timeLabel(t)}`}
                className="ml-0.5 rounded-full p-1 text-blue-500 hover:bg-blue-100 hover:text-blue-800"
                data-testid={`an-time-remove-${t}`}
              >
                <X size={13} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-slate-500">No time yet: add one below.</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="time"
          step={60}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setProblem(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add(draft);
            }
          }}
          disabled={full}
          className="h-9 w-36"
          aria-label="New sending time"
          data-testid="an-time-input"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9 gap-1.5"
          onClick={() => add(draft)}
          disabled={full}
          data-testid="an-time-add"
        >
          <Plus size={14} /> Add time
        </Button>
        <span className="text-[11px] text-slate-400">Quick:</span>
        {QUICK_TIMES.filter((t) => !times.includes(t)).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => add(t)}
            disabled={full}
            className="rounded-full border border-slate-200 px-2 py-0.5 text-[11px] font-semibold text-slate-600 hover:border-blue-300 hover:text-blue-700 disabled:opacity-50"
            data-testid={`an-time-quick-${t}`}
          >
            {timeLabel(t)}
          </button>
        ))}
      </div>
    </Field>
  );
}

export function ScheduleStep({ draft, onChange, problems, today }: StepProps & { today: string }) {
  const upcoming = nextRuns(new Date(), draft, 3);
  return (
    <div className="space-y-5" data-testid="an-step-schedule">
      <Field label="How often" error={problemOf(problems, "days", "runOn")}>
        <div className="space-y-3">
          <Segmented
            options={[
              { value: "daily", label: "Every day", icon: Repeat },
              { value: "weekly", label: "Chosen weekdays", icon: CalendarDays },
              { value: "once", label: "Once", icon: CalendarClock },
            ]}
            value={draft.frequency}
            onChange={(frequency) => onChange({ frequency })}
            ariaLabel="Frequency"
            testId="an-frequency"
          />
          {draft.frequency === "weekly" && (
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Weekdays" data-testid="an-days">
              {WEEKDAYS.map((d) => {
                const on = draft.days.includes(d.value);
                return (
                  <button
                    key={d.value}
                    type="button"
                    aria-pressed={on}
                    aria-label={d.long}
                    onClick={() => onChange({ days: toggleDay(draft.days, d.value) })}
                    className={cn(
                      "min-w-11 rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors",
                      on
                        ? "border-blue-600 bg-blue-600 text-white"
                        : "border-slate-200 text-slate-600 hover:border-blue-300",
                    )}
                    data-view-safe
                    data-testid={`an-day-${d.value}`}
                  >
                    {d.short}
                  </button>
                );
              })}
            </div>
          )}
          {draft.frequency === "once" && (
            <Input
              type="date"
              value={draft.runOn ?? ""}
              min={today}
              onChange={(e) => onChange({ runOn: e.target.value || null })}
              className="h-9 w-44"
              aria-label="Send on"
              data-testid="an-run-on"
            />
          )}
        </div>
      </Field>

      <TimesEditor times={draft.times} onChange={(times) => onChange({ times })} error={problemOf(problems, "times")} />

      <ToggleRow
        id="an-active"
        label={draft.isActive ? "Switched on" : "Switched off"}
        hint={
          draft.isActive
            ? "It sends at the times above once saved."
            : "Saved, but it sends nothing until it is switched on."
        }
      >
        <Switch
          id="an-active"
          checked={draft.isActive}
          onCheckedChange={(isActive) => onChange({ isActive })}
          data-testid="an-active"
        />
      </ToggleRow>

      <div className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2.5" data-testid="an-next-sends">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Next sends</p>
        {!draft.isActive ? (
          <p className="text-sm text-slate-600">None: it is switched off.</p>
        ) : upcoming.length === 0 ? (
          <p className="text-sm text-slate-600">None with these settings.</p>
        ) : (
          <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm font-semibold text-slate-800">
            {upcoming.map((d) => (
              <li key={d.toISOString()}>{whenText(d)}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
