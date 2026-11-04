import { useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  BellRing,
  CalendarClock,
  Clock,
  Eye,
  Lock,
  Mail,
  MessageSquareText,
  Plus,
  RotateCcw,
  Save,
  Smartphone,
  X,
} from "lucide-react";
import { Chip, SectionCard } from "@/components/payroll/kit/parts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { HodChannel, HodChannelStatus, HodPreviewMessage, HodRun } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import {
  CHANNEL_LABEL,
  EMAIL_SUBJECT,
  MAX_TIMES,
  PLACEHOLDERS,
  PUSH_TITLE,
  RUN_STATUS,
  TEMPLATE_MAX,
  WEEKDAYS,
  addTime,
  insertAt,
  istLabel,
  removeTime,
  runTitle,
  scheduleText,
  timeLabel,
  toggleDay,
  type NotifyForm,
} from "./logic";

type IconType = typeof Mail;

export const CHANNEL_ICON: Record<HodChannel, IconType> = {
  whatsapp: MessageSquareText,
  email: Mail,
  push: Smartphone,
};

/** The plain note a view-only or branch-limited login sees above the read-only page. */
export function ReadOnlyNote({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex items-start gap-2.5 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700"
      role="note"
      data-testid="notify-read-only"
    >
      <Lock size={16} className="mt-0.5 shrink-0 text-slate-500" aria-hidden />
      <p>{children}</p>
    </div>
  );
}

/** On / off, the schedule in words, the next and the last run. */
export function MasterCard({
  form,
  onChange,
  readOnly,
  nextRunAt,
  upcoming,
  dirty,
  lastRun,
}: {
  form: NotifyForm;
  onChange: (enabled: boolean) => void;
  readOnly: boolean;
  /** The server's next run for what is saved. */
  nextRunAt: string | null;
  /** The next runs of what is on screen (shown while it is not saved). */
  upcoming: Date[];
  dirty: boolean;
  lastRun: HodRun | null;
}) {
  return (
    <SectionCard
      icon={BellRing}
      title="Automatic reminders to HoDs"
      description="Every HoD with requests waiting for their approval gets a personal reminder at the times below. A HoD with nothing pending gets nothing."
      testId="notify-master"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Switch
            id="hod-reminders-enabled"
            checked={form.enabled}
            onCheckedChange={onChange}
            disabled={readOnly}
            data-testid="notify-enabled"
          />
          <Label htmlFor="hod-reminders-enabled" className="text-sm font-semibold text-gray-900">
            {form.enabled ? "Reminders are on" : "Reminders are off"}
          </Label>
        </div>
        <p className="text-xs text-gray-600" data-testid="notify-schedule-text">
          {form.enabled ? `${scheduleText(form)} (India time)` : "Nothing is sent automatically. Send now still works."}
        </p>
      </div>
      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <div className="rounded-xl bg-slate-50 px-3 py-2.5">
          <dt className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Next reminder</dt>
          <dd className="font-bold text-gray-900" data-testid="notify-next-run">
            {dirty
              ? form.enabled && upcoming.length
                ? `${istLabel(upcoming[0])} (after you save)`
                : "None after you save"
              : nextRunAt
                ? istLabel(nextRunAt)
                : form.enabled
                  ? "Not scheduled"
                  : "Off"}
          </dd>
        </div>
        <div className="rounded-xl bg-slate-50 px-3 py-2.5">
          <dt className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Last run</dt>
          <dd className="flex flex-wrap items-center gap-1.5 font-bold text-gray-900" data-testid="notify-last-run">
            {lastRun ? (
              <>
                {istLabel(lastRun.startedAt)}
                <span className="text-xs font-medium text-gray-500">{runTitle(lastRun)}</span>
                <Chip tone={RUN_STATUS[lastRun.status].tone}>{RUN_STATUS[lastRun.status].label}</Chip>
              </>
            ) : (
              "Never"
            )}
          </dd>
        </div>
      </dl>
    </SectionCard>
  );
}

/** The times of day (up to six) and the weekdays. */
export function ScheduleCard({
  form,
  onChange,
  readOnly,
}: {
  form: NotifyForm;
  onChange: (patch: Partial<NotifyForm>) => void;
  readOnly: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const full = form.times.length >= MAX_TIMES;

  const add = () => {
    const next = addTime(form.times, draft);
    setError(next.error);
    if (!next.error) {
      onChange({ times: next.times });
      setDraft("");
    }
  };

  return (
    <SectionCard
      icon={CalendarClock}
      title="When"
      description="One or more times a day, India time, on the days picked. A time is sent once a day at most, even after a restart."
      testId="notify-schedule"
    >
      <div className="space-y-4">
        <div className="space-y-2">
          <p className="text-xs font-semibold text-gray-700" id="notify-times-label">
            Times of day{" "}
            <span className="font-normal text-gray-400">
              ({form.times.length} of {MAX_TIMES})
            </span>
          </p>
          {form.times.length === 0 ? (
            <p className="text-xs text-gray-500" data-testid="notify-no-times">
              No time yet: add one below.
            </p>
          ) : (
            <ul className="flex flex-wrap gap-2" aria-labelledby="notify-times-label" data-testid="notify-times">
              {form.times.map((t) => (
                <li
                  key={t}
                  className="inline-flex items-center gap-1 rounded-full border border-blue-200 bg-blue-50 py-1 pl-3 pr-1 text-sm font-semibold text-blue-800"
                >
                  <Clock size={13} aria-hidden />
                  {timeLabel(t)}
                  <button
                    type="button"
                    onClick={() => onChange({ times: removeTime(form.times, t) })}
                    disabled={readOnly}
                    aria-label={`Remove ${timeLabel(t)}`}
                    className="ml-0.5 rounded-full p-1 text-blue-500 hover:bg-blue-100 hover:text-blue-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
                    data-testid={`notify-remove-${t}`}
                  >
                    <X size={13} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor="notify-new-time" className="text-[11px] text-gray-500">
                New time
              </Label>
              <Input
                id="notify-new-time"
                type="time"
                step={60}
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    add();
                  }
                }}
                disabled={readOnly || full}
                className="h-9 w-36"
                aria-describedby={error ? "notify-time-error" : undefined}
                data-testid="notify-time-input"
              />
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-9 gap-1.5"
              onClick={add}
              disabled={readOnly || full || !draft}
              data-testid="notify-add-time"
            >
              <Plus size={14} /> Add time
            </Button>
          </div>
          {error ? (
            <p id="notify-time-error" role="alert" className="text-xs font-medium text-red-600">
              {error}
            </p>
          ) : (
            full && <p className="text-xs text-gray-500">That is the most: remove a time to add another.</p>
          )}
        </div>

        <div className="space-y-2">
          <p className="text-xs font-semibold text-gray-700" id="notify-days-label">
            Days
          </p>
          <div
            className="flex flex-wrap gap-1.5"
            role="group"
            aria-labelledby="notify-days-label"
            data-testid="notify-days"
          >
            {WEEKDAYS.map((d) => {
              const on = form.days.includes(d.value);
              return (
                <button
                  key={d.value}
                  type="button"
                  aria-pressed={on}
                  aria-label={d.long}
                  disabled={readOnly}
                  onClick={() => onChange({ days: toggleDay(form.days, d.value) })}
                  className={cn(
                    "min-w-11 rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-60",
                    on
                      ? "border-blue-600 bg-blue-600 text-white"
                      : "border-gray-200 text-gray-600 hover:border-blue-300",
                  )}
                  data-testid={`notify-day-${d.value}`}
                >
                  {d.short}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </SectionCard>
  );
}

/** WhatsApp / Email / Mobile push, each switchable, each with what the server says about it. */
export function ChannelsCard({
  form,
  onChange,
  status,
  readOnly,
}: {
  form: NotifyForm;
  onChange: (channels: NotifyForm["channels"]) => void;
  status: Record<HodChannel, HodChannelStatus> | undefined;
  readOnly: boolean;
}) {
  return (
    <SectionCard
      icon={MessageSquareText}
      title="Channels"
      description="The same message goes on every channel that is on. Email gets a subject, the push a title."
      testId="notify-channels"
    >
      <ul className="space-y-2.5">
        {(["whatsapp", "email", "push"] as HodChannel[]).map((c) => {
          const Icon = CHANNEL_ICON[c];
          const s = status?.[c];
          const id = `notify-channel-${c}`;
          return (
            <li
              key={c}
              className="flex items-start gap-3 rounded-xl border border-slate-100 px-3 py-2.5"
              data-testid={id}
            >
              <span className="mt-0.5 rounded-lg bg-slate-50 p-1.5 text-slate-600">
                <Icon size={15} aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <Label htmlFor={`${id}-switch`} className="text-sm font-semibold text-gray-900">
                  {CHANNEL_LABEL[c]}
                </Label>
                {s && (
                  <p
                    className={cn(
                      "mt-0.5 flex items-start gap-1 text-xs",
                      s.available ? "text-gray-500" : "font-medium text-amber-700",
                    )}
                    data-testid={`${id}-note`}
                  >
                    {!s.available && <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden />}
                    {s.note || (s.available ? "Ready" : "Not available")}
                  </p>
                )}
                {c === "email" && <p className="mt-0.5 text-[11px] text-gray-400">Subject: {EMAIL_SUBJECT}</p>}
                {c === "push" && (
                  <p className="mt-0.5 text-[11px] text-gray-400">Title: {PUSH_TITLE} · a tap opens Approvals</p>
                )}
              </div>
              <Switch
                id={`${id}-switch`}
                checked={form.channels[c]}
                onCheckedChange={(on) => onChange({ ...form.channels, [c]: on })}
                disabled={readOnly}
                aria-describedby={s ? `${id}-note` : undefined}
                data-testid={`${id}-switch`}
              />
            </li>
          );
        })}
      </ul>
    </SectionCard>
  );
}

/** The message: placeholder chips that insert at the caret, the text, its length and problems, Reset to default. */
export function TemplateCard({
  form,
  onChange,
  defaultTemplate,
  problem,
  readOnly,
}: {
  form: NotifyForm;
  onChange: (template: string) => void;
  defaultTemplate: string;
  problem: string | null;
  readOnly: boolean;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const insert = (token: string) => {
    const el = area.current;
    const start = el?.selectionStart ?? form.template.length;
    const end = el?.selectionEnd ?? start;
    const next = insertAt(form.template, token, start, end);
    onChange(next.text);
    // the caret goes after what was inserted (once React has put the new text in), so a second click carries on from there
    window.setTimeout(() => {
      if (!area.current) return;
      area.current.focus();
      area.current.setSelectionRange(next.caret, next.caret);
    }, 0);
  };
  const atDefault = form.template === defaultTemplate;

  return (
    <SectionCard
      icon={MessageSquareText}
      title="Message"
      description="Written once, personalised for each HoD. Put the placeholders where the HoD's details should go."
      testId="notify-template"
      actions={
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 text-gray-600"
          onClick={() => onChange(defaultTemplate)}
          disabled={readOnly || atDefault || !defaultTemplate}
          data-testid="notify-template-reset"
        >
          <RotateCcw size={13} /> Reset to default
        </Button>
      }
    >
      <div className="space-y-2">
        <div
          className="flex flex-wrap gap-1.5"
          role="group"
          aria-label="Placeholders"
          data-testid="notify-placeholders"
        >
          {PLACEHOLDERS.map((p) => (
            <button
              key={p.token}
              type="button"
              onClick={() => insert(p.token)}
              disabled={readOnly}
              title={p.hint}
              aria-label={`Insert ${p.label} placeholder ${p.token}`}
              className="rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-1 font-mono text-[11px] font-semibold text-indigo-700 hover:bg-indigo-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
              data-testid={`notify-insert-${p.token.replace(/[{}]/g, "")}`}
            >
              {p.token}
            </button>
          ))}
        </div>
        <Label htmlFor="notify-template-text" className="sr-only">
          Reminder message
        </Label>
        <Textarea
          id="notify-template-text"
          ref={area}
          value={form.template}
          onChange={(e) => onChange(e.target.value)}
          readOnly={readOnly}
          rows={10}
          aria-invalid={!!problem}
          aria-describedby="notify-template-help"
          className="font-mono text-[13px] leading-relaxed"
          data-testid="notify-template-text"
        />
        <div id="notify-template-help" className="flex flex-wrap items-start justify-between gap-2 text-xs">
          {problem ? (
            <p role="alert" className="font-medium text-red-600" data-testid="notify-template-problem">
              {problem}
            </p>
          ) : (
            <p className="text-gray-500">
              {"{{pendingList}}"} becomes one line per kind of request with something pending, e.g. "• Leave Requests:
              3".
            </p>
          )}
          <span className={cn("tabular-nums", form.template.length > TEMPLATE_MAX ? "text-red-600" : "text-gray-400")}>
            {form.template.length} / {TEMPLATE_MAX}
          </span>
        </div>
      </div>
    </SectionCard>
  );
}

/** What one HoD would get now, from the server (nothing is sent). */
export function PreviewCard({
  messages,
  loading,
  error,
  unsaved,
}: {
  messages: HodPreviewMessage[] | undefined;
  loading: boolean;
  error: string | null;
  /** The preview is of the message on screen, not the saved one. */
  unsaved: boolean;
}) {
  const [picked, setPicked] = useState<number | null>(null);
  const list = messages ?? [];
  const current = list.find((m) => m.managerId === picked) ?? list[0] ?? null;

  return (
    <SectionCard
      icon={Eye}
      title="Preview"
      description={
        unsaved
          ? "Your message as each HoD would get it now (not saved yet). Nothing is sent."
          : "The saved message as each HoD would get it now. Nothing is sent."
      }
      testId="notify-preview"
    >
      {error ? (
        <p
          className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800"
          role="status"
          data-testid="notify-preview-error"
        >
          {error}
        </p>
      ) : loading && !messages ? (
        <div className="space-y-2" aria-busy>
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : list.length === 0 ? (
        <p
          className="rounded-xl bg-slate-50 px-3 py-6 text-center text-sm text-gray-500"
          data-testid="notify-preview-empty"
        >
          No HoD has anything pending right now: a reminder now would reach nobody.
        </p>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-gray-600" data-testid="notify-preview-count">
              <b>{list.length}</b> HoD{list.length === 1 ? "" : "s"} would get a reminder now
            </p>
            <Select value={String(current?.managerId ?? "")} onValueChange={(v) => setPicked(Number(v))}>
              <SelectTrigger
                className="h-9 w-full sm:w-64"
                aria-label="Preview the message of"
                data-testid="notify-preview-pick"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {list.map((m) => (
                  <SelectItem key={m.managerId} value={String(m.managerId)}>
                    {m.name} · {m.pending} pending
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {current && (
            <div className="rounded-2xl bg-[#e7f6e9] p-3" aria-live="polite">
              <div
                className="whitespace-pre-wrap break-words rounded-xl rounded-tl-sm bg-white px-3.5 py-2.5 text-[13px] leading-relaxed text-gray-900 shadow-sm"
                data-testid="notify-preview-text"
              >
                {current.text}
              </div>
            </div>
          )}
        </div>
      )}
    </SectionCard>
  );
}

/** Save / Discard, with the problems that stop a save and the advice that does not. Sticks to the bottom while dirty. */
export function SaveDock({
  dirty,
  saving,
  problems,
  warnings,
  readOnly,
  onSave,
  onDiscard,
}: {
  dirty: boolean;
  saving: boolean;
  problems: string[];
  warnings: string[];
  readOnly: boolean;
  onSave: () => void;
  onDiscard: () => void;
}) {
  if (readOnly) return null;
  return (
    <div
      className={cn(
        "space-y-1.5 rounded-2xl border px-4 py-3 transition-colors",
        dirty ? "sticky bottom-3 z-20 border-amber-200 bg-amber-50 shadow-lg" : "border-slate-100 bg-white",
      )}
      data-testid="notify-save-dock"
      data-dirty={dirty ? "true" : "false"}
    >
      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          onClick={onSave}
          disabled={!dirty || saving || problems.length > 0}
          className="gap-1.5"
          data-testid="notify-save"
        >
          <Save size={13} /> {saving ? "Saving…" : "Save changes"}
        </Button>
        {dirty && (
          <Button
            size="sm"
            variant="ghost"
            onClick={onDiscard}
            disabled={saving}
            className="gap-1.5 text-gray-600"
            data-testid="notify-discard"
          >
            <RotateCcw size={13} /> Discard changes
          </Button>
        )}
        <span className={cn("text-xs font-medium", dirty ? "text-amber-800" : "text-gray-400")}>
          {dirty ? "You have changes that are not saved yet." : "Everything shown is saved."}
        </span>
      </div>
      {problems.map((p) => (
        <p key={p} role="alert" className="text-xs font-medium text-red-600">
          {p}
        </p>
      ))}
      {warnings.map((w) => (
        <p key={w} className="flex items-start gap-1 text-xs text-amber-800">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden /> {w}
        </p>
      ))}
    </div>
  );
}
