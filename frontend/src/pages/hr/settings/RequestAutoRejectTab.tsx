import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CalendarX2,
  ChevronLeft,
  ChevronRight,
  History,
  ListChecks,
  Lock,
  Play,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { ApiError } from "@/lib/api-client/custom-fetch";
import {
  useRequestAutoRejectConfig,
  useRequestAutoRejectHistory,
  useRunRequestAutoRejectNow,
  useUpdateRequestAutoReject,
  type AutoRejectConfigErrors,
  type AutoRejectConfigInput,
  type AutoRejectDueItem,
  type AutoRejectKind,
} from "@/lib/api-client/custom-hooks";
import { Field, ToggleField } from "./kit/Field";
import { PreviewCard, PreviewLine, SettingBlock, SettingsSection, type Affect } from "./kit/SettingBlock";
import { REQUEST_AUTO_REJECT_SETTINGS } from "./RequestAutoRejectTab.meta";
import { errorText } from "./identity/errors";
import { metaOf } from "./identity/meta";
import { SaveFooter } from "./identity/SaveFooter";
import { useDraft } from "./identity/useDraft";
import {
  countsText,
  dayText,
  indiaDay,
  parseDays,
  plural,
  rejectedOnDay,
  ruleSentence,
  runText,
  stampText,
  validateDays,
  type AutoRejectForm,
} from "./request-auto-reject/logic";

const meta = (id: string) => metaOf(REQUEST_AUTO_REJECT_SETTINGS, id);

const HISTORY_PAGE_SIZE = 25;
const DEFAULT_LIMITS = { min: 7, max: 365, default: 45 };

const AFFECTS: Affect[] = [
  {
    where: "Requests",
    what: "a request waiting longer than this is rejected, with the remark saying why",
    to: "/hr/requests",
  },
  { where: "Employee apps", what: "the employee sees it rejected and gets the usual notice and phone notification" },
  { where: "WhatsApp", what: "never: an automatic rejection sends no WhatsApp message" },
];

/** The value after it has stopped changing for `ms` (so typing a number does not ask the server at every key). */
function useSettled<T>(value: T, ms = 350): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

function KindChips({
  byKind,
  kinds,
  testId,
}: {
  byKind: Record<string, number>;
  kinds: AutoRejectKind[];
  testId: string;
}) {
  const entries = kinds.filter((k) => (byKind[k.key] ?? 0) > 0);
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5" data-testid={testId}>
      {entries.map((k) => (
        <span
          key={k.key}
          className="settings-chip inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium text-slate-600"
        >
          {k.label} <b className="tabular-nums text-slate-900">{byKind[k.key]}</b>
        </span>
      ))}
    </div>
  );
}

function DueTable({ items }: { items: AutoRejectDueItem[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200">
      <table className="w-full min-w-[640px] text-left text-[13px]">
        <thead className="bg-slate-50 text-[11px] font-medium uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-3 py-2">Request</th>
            <th className="px-3 py-2">Employee</th>
            <th className="px-3 py-2">Submitted</th>
            <th className="px-3 py-2 text-right">Waiting</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.key} className="border-t border-slate-100 align-top" data-testid="ar-due-row">
              <td className="px-3 py-2">
                <p className="font-semibold text-slate-900">{item.what || item.kindLabel}</p>
                <p className="text-[12px] text-slate-500">
                  <span className="font-medium text-slate-600">{item.kindLabel}</span>
                  {item.summary ? ` · ${item.summary}` : ""}
                </p>
                {item.voidedWith && (
                  <p className="mt-0.5 text-[11px] font-medium text-amber-700" data-testid="ar-due-voided-with">
                    Voided together with its On-Duty request (one notice for both).
                  </p>
                )}
              </td>
              <td className="px-3 py-2">
                <p className="font-medium text-slate-800">{item.employee.name}</p>
                <p className="text-[12px] text-slate-500">
                  {item.employee.code}
                  {item.employee.branch ? ` · ${item.employee.branch}` : ""}
                </p>
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-slate-700">{dayText(item.submittedOn)}</td>
              <td className="whitespace-nowrap px-3 py-2 text-right font-semibold tabular-nums text-slate-900">
                {plural(item.daysWaiting, "day")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HistoryList({ kinds }: { kinds: AutoRejectKind[] }) {
  const [page, setPage] = useState(1);
  const [kind, setKind] = useState("");
  const history = useRequestAutoRejectHistory(page, HISTORY_PAGE_SIZE, kind);
  const data = history.data;
  const items = data?.items ?? [];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-slate-600">
        <label htmlFor="ar-history-kind">Show</label>
        <select
          id="ar-history-kind"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value);
            setPage(1);
          }}
          className="h-8 rounded-md border border-slate-200 bg-white px-2 text-[13px] text-slate-800"
          data-testid="ar-history-kind"
        >
          <option value="">Every kind</option>
          {kinds.map((k) => (
            <option key={k.key} value={k.key}>
              {k.label}
            </option>
          ))}
        </select>
        {data && (
          <span className="text-slate-500" data-testid="ar-history-total">
            {plural(data.total, "request")} rejected automatically so far
          </span>
        )}
      </div>
      {history.isError && !data ? (
        <p className="text-sm text-red-700">The history could not be loaded: {errorText(history.error)}</p>
      ) : items.length === 0 ? (
        <p
          className="rounded-lg border border-dashed border-slate-200 px-3 py-4 text-sm text-slate-500"
          data-testid="ar-history-empty"
        >
          {data ? "No request has been rejected automatically yet." : "Loading the history…"}
        </p>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {items.map((row) => (
            <li
              key={row.id}
              className="grid gap-x-4 gap-y-1 px-3 py-2.5 sm:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]"
              data-testid="ar-history-row"
            >
              <div className="min-w-0">
                <p className="text-[13px] font-semibold text-slate-900">
                  {row.what || row.kindLabel}
                  <span className="font-normal text-slate-500">
                    {" "}
                    · {row.employee.name} ({row.employee.code})
                  </span>
                </p>
                <p className="text-[12px] text-slate-500">
                  <span className="font-medium text-slate-600">{row.kindLabel}</span>
                  {row.summary ? ` · ${row.summary}` : ""}
                </p>
                {row.effectsText.length > 0 && (
                  <ul className="mt-1 space-y-0.5 text-[11px] text-slate-500">
                    {row.effectsText.map((t) => (
                      <li key={t}>{t}</li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="text-[12px] leading-snug text-slate-600 sm:text-right">
                <p>
                  Submitted <b className="text-slate-800">{dayText(indiaDay(row.submittedAt))}</b> · waited{" "}
                  {plural(row.daysWaited, "day")}
                </p>
                <p>
                  Rejected <b className="text-slate-800">{stampText(row.rejectedAt)}</b>
                </p>
                <p className="text-slate-500" data-testid="ar-history-by">
                  {row.by}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
      {data && data.pages > 1 && (
        <div className="flex items-center justify-end gap-2 text-[12px] text-slate-600">
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            data-testid="ar-history-prev"
          >
            <ChevronLeft size={13} /> Previous
          </Button>
          <span className="tabular-nums">
            Page {data.page} of {data.pages}
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1"
            disabled={page >= data.pages}
            onClick={() => setPage((p) => p + 1)}
            data-testid="ar-history-next"
          >
            Next <ChevronRight size={13} />
          </Button>
        </div>
      )}
    </div>
  );
}

export default function RequestAutoRejectTab({ readOnly = false }: { readOnly?: boolean }) {
  const { toast } = useToast();
  const config = useRequestAutoRejectConfig(null);
  const update = useUpdateRequestAutoReject();
  const runNow = useRunRequestAutoRejectNow();
  const data = config.data;

  const saved = useMemo<AutoRejectForm>(
    () => ({ enabled: data?.enabled ?? true, days: String(data?.days ?? DEFAULT_LIMITS.default) }),
    [data?.enabled, data?.days],
  );
  const { form, set, discard, dirty } = useDraft(saved);
  const [serverProblem, setServerProblem] = useState<string | undefined>();
  const [confirming, setConfirming] = useState(false);

  const limits = data?.limits ?? DEFAULT_LIMITS;
  const daysProblem = validateDays(form.days, limits);
  const typedDays = daysProblem ? null : parseDays(form.days);
  const settledDays = useSettled(typedDays);
  // the due list for a number of days typed but not saved yet (the saved list otherwise)
  const previewDays = data && dirty && settledDays !== null && settledDays !== data.days ? settledDays : null;
  const preview = useRequestAutoRejectConfig(previewDays);
  const due = previewDays ? (preview.data?.due ?? null) : (data?.due ?? null);
  const shownDays = typedDays ?? data?.days ?? DEFAULT_LIMITS.default;

  const canChange = !readOnly && data?.canChange === true;
  const canRun = !readOnly && data?.canRun === true;
  const kinds = data?.kinds ?? [];
  const savedDue = data?.due;

  const change = <K extends keyof AutoRejectForm>(key: K, value: AutoRejectForm[K]) => {
    set(key, value);
    setServerProblem(undefined);
    setConfirming(false);
  };

  const save = async () => {
    if (!data) return;
    if (daysProblem || typedDays === null) {
      toast({ title: "Check the number of days", description: daysProblem, variant: "destructive" });
      return;
    }
    const input: AutoRejectConfigInput = {};
    if (form.enabled !== data.enabled) input.enabled = form.enabled;
    if (typedDays !== data.days) input.days = typedDays;
    try {
      await update.mutateAsync(input);
      discard();
      setServerProblem(undefined);
      toast({
        title: "Auto-reject settings saved",
        description: form.enabled
          ? `From the next run (${data.runAt}), requests waiting more than ${plural(typedDays, "day")} are rejected automatically.`
          : "Nothing is rejected automatically until it is switched on again.",
      });
    } catch (e) {
      const body = e instanceof ApiError ? (e.data as AutoRejectConfigErrors | null) : null;
      setServerProblem(body?.errors?.days ?? body?.errors?.enabled);
      toast({ title: "Couldn't save the auto-reject settings", description: errorText(e), variant: "destructive" });
    }
  };

  const run = async () => {
    try {
      const result = await runNow.mutateAsync();
      setConfirming(false);
      toast({
        title:
          result.summary.rejected > 0 ? `${plural(result.summary.rejected, "request")} rejected` : "Nothing was due",
        description: runText(result.summary, kinds),
      });
    } catch (e) {
      toast({ title: "Couldn't run the automatic rejection", description: errorText(e), variant: "destructive" });
    }
  };

  if (config.isError && !data) {
    return (
      <div className="settings-glass rounded-xl p-6 text-sm text-slate-600" data-testid="ar-error">
        <p className="font-semibold text-slate-900">The auto-reject settings could not be loaded.</p>
        <p className="mt-1">{errorText(config.error) ?? "Check the connection and try again."}</p>
        <Button size="sm" variant="outline" className="mt-3 gap-1.5" onClick={() => void config.refetch()}>
          <RefreshCw size={13} /> Try again
        </Button>
      </div>
    );
  }

  const today = indiaDay(new Date());
  const runBlocked = !canRun
    ? readOnly || !data
      ? "View only: Run now needs the Settings edit right."
      : "Your login may look at this tab but not run it."
    : dirty
      ? "Save the changes first: Run now uses the saved number of days."
      : !savedDue || savedDue.total === 0
        ? "Nothing is due right now."
        : undefined;

  return (
    <div className="space-y-4">
      <SettingsSection
        icon={CalendarX2}
        title="Automatic rejection of waiting requests"
        purpose="A request that waits too long for a decision is closed the way a rejection by HR closes it: the request's own rejected status, a remark the employee reads, and the in-app notice and phone notification. No WhatsApp message is sent for an automatic rejection."
        testId="ar-summary"
      >
        {data && !data.canChange && data.canRun && !readOnly && (
          <div
            className="mb-3 flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800"
            data-testid="ar-company-wide-notice"
          >
            <Lock size={14} className="mt-0.5 shrink-0" />
            <span>
              The switch and the days are one company-wide rule, so only a login for all units can change them. Run now
              here rejects the due requests of your unit only.
            </span>
          </div>
        )}
        <p
          className="settings-clay-inset rounded-xl px-4 py-3 text-[14px] leading-relaxed text-slate-800"
          aria-live="polite"
          data-testid="ar-sentence"
        >
          {ruleSentence(shownDays, form.enabled)}
        </p>
        <p className="mt-2 text-[12px] leading-snug text-slate-500">
          It runs every night at {data?.runAt ?? "01:30"} India time. The days are counted from the day a request was
          submitted, not the day it is for. A request decided before the run is never touched, and a day whose payroll
          is finalized keeps its attendance.
          {data?.updatedBy && data.updatedAt && (
            <span className="mt-1 block" data-testid="ar-updated">
              Last changed by {data.updatedBy} on {stampText(data.updatedAt)}.
            </span>
          )}
        </p>

        <SettingBlock {...meta("ar-switch")} labelFor="ar-switch-toggle" defaultText="On" affects={AFFECTS}>
          <ToggleField
            id="ar-switch-toggle"
            checked={form.enabled}
            disabled={!canChange}
            onChange={(v) => change("enabled", v)}
            onLabel="Waiting requests are rejected automatically"
            offLabel="Nothing is rejected automatically"
          >
            {form.enabled
              ? "Every night, after the number of days below."
              : "The nightly run does nothing. Run now below still rejects what is due, when pressed."}
          </ToggleField>
        </SettingBlock>

        <SettingBlock
          {...meta("ar-days")}
          labelFor="ar-days-input"
          defaultText={`${DEFAULT_LIMITS.default} days`}
          note="Lowering the number makes more requests due at once: the list below shows them before you save."
          preview={
            <PreviewCard title="If nobody decides it" scenario="Worked out from the number on screen, before saving.">
              {typedDays !== null ? (
                <>
                  <PreviewLine
                    label={`Submitted today (${dayText(today)})`}
                    result={`rejected in the night of ${dayText(rejectedOnDay(today, typedDays))}`}
                    tone="warn"
                  />
                  <PreviewLine
                    label={`Submitted ${plural(typedDays, "day")} ago`}
                    result="still waits tonight (exactly the limit)"
                    tone="good"
                  />
                </>
              ) : (
                <PreviewLine label="Enter a valid number" result="to see the dates" tone="neutral" />
              )}
            </PreviewCard>
          }
        >
          <Field
            label="Days a request may wait"
            htmlFor="ar-days-input"
            unit="days"
            error={daysProblem ?? serverProblem}
            hint={`From ${limits.min} to ${limits.max} days.`}
          >
            <Input
              id="ar-days-input"
              inputMode="numeric"
              className="w-28 tabular-nums"
              value={form.days}
              disabled={!canChange}
              aria-invalid={daysProblem || serverProblem ? true : undefined}
              onChange={(e) => change("days", e.target.value)}
              data-testid="ar-days"
            />
          </Field>
        </SettingBlock>

        {kinds.length > 0 && (
          <p
            className="settings-divide border-t pt-4 text-[12px] leading-relaxed text-slate-500"
            data-testid="ar-kinds"
          >
            Covers: {kinds.map((k) => k.label).join(", ")}. Never:{" "}
            {(data?.neverRejected ?? []).map((k) => k.label).join(", ") || "Resignation"}.
          </p>
        )}
      </SettingsSection>

      <SettingsSection icon={ListChecks} title="Due at the next run" testId="ar-due">
        {/* the search target (#ar-due): a setting block like every other one, its list spanning the whole width */}
        <SettingBlock
          {...meta("ar-due")}
          purpose={
            previewDays
              ? `With ${plural(previewDays, "day")} (not saved yet): what the next run would reject, oldest first.`
              : "The requests the next run would reject, oldest first. Run now rejects them at once."
          }
          className="lg:grid-cols-1"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[15px] font-semibold text-slate-900" data-testid="ar-due-count">
                {due ? `${plural(due.total, "request")} ${due.total === 1 ? "is" : "are"} due` : "Loading…"}
              </p>
              <p className="text-[12px] text-slate-500">
                {!form.enabled && !dirty
                  ? "The switch is off, so the nightly run rejects none of them."
                  : `Next run: tonight at ${data?.runAt ?? "01:30"}.`}
                {data?.branchScoped ? " Only your unit's requests are listed." : ""}
              </p>
            </div>
            <Button
              size="sm"
              className="gap-1.5"
              disabled={Boolean(runBlocked) || runNow.isPending}
              onClick={() => setConfirming(true)}
              title={runBlocked}
              data-testid="ar-run-now"
            >
              <Play size={13} /> Run now
            </Button>
          </div>
          {runBlocked && canRun && <p className="mt-1 text-right text-[11px] text-slate-500">{runBlocked}</p>}

          {confirming && savedDue && (
            <div
              className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-[13px] text-red-900"
              role="alertdialog"
              aria-label="Confirm Run now"
              data-testid="ar-run-confirm"
            >
              <p className="flex items-start gap-2 font-semibold">
                <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                Reject {plural(savedDue.total, "waiting request")} now?
              </p>
              <p className="mt-1 text-[12px] leading-snug">
                {countsText(savedDue.byKind, kinds)}. Each one is rejected the way its own page rejects it, with the
                remark &ldquo;no decision within {plural(data?.days ?? 0, "day")} of being submitted&rdquo;. Each
                employee gets the usual in-app notice and phone notification; no WhatsApp message is sent. This cannot
                be undone.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="destructive"
                  className="gap-1.5"
                  disabled={runNow.isPending}
                  onClick={() => void run()}
                  data-testid="ar-run-confirm-button"
                >
                  {runNow.isPending ? "Rejecting…" : `Reject ${plural(savedDue.total, "request")}`}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={runNow.isPending}
                  onClick={() => setConfirming(false)}
                  data-testid="ar-run-cancel"
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {due && due.total > 0 && (
            <div className="mt-3 space-y-2">
              <KindChips byKind={due.byKind} kinds={kinds} testId="ar-due-kinds" />
              <DueTable items={due.items} />
              {due.truncated && (
                <p className="text-[12px] text-slate-500">
                  The oldest {due.items.length} are listed; all {due.total} are rejected by the run.
                </p>
              )}
            </div>
          )}
          {due && due.total === 0 && (
            <p
              className="mt-3 rounded-lg border border-dashed border-slate-200 px-3 py-4 text-sm text-slate-500"
              data-testid="ar-due-empty"
            >
              Nothing is due: every waiting request was submitted {plural(due.days, "day")} ago or less.
            </p>
          )}

          {data?.lastRun && (
            <div
              className="settings-divide mt-4 border-t pt-3 text-[12px] leading-snug text-slate-600"
              data-testid="ar-last-run"
            >
              <p className="font-semibold text-slate-800">Last run</p>
              <p>{runText(data.lastRun, kinds)}</p>
              {data.lastRun.attendanceSkipped > 0 && (
                <p className="text-amber-800">
                  {plural(data.lastRun.attendanceSkipped, "day")} kept{" "}
                  {data.lastRun.attendanceSkipped === 1 ? "its" : "their"} attendance because the payroll was already
                  finalized.
                </p>
              )}
              {data.lastRun.failures.length > 0 && (
                <ul className="mt-1 list-disc pl-4 text-red-700">
                  {data.lastRun.failures.map((f) => (
                    <li key={`${f.kind}-${f.id}`}>
                      {kinds.find((k) => k.key === f.kind)?.label ?? f.kind} #{f.id}: {f.error}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </SettingBlock>
      </SettingsSection>

      <SettingsSection icon={History} title="Rejected automatically" testId="ar-history">
        <SettingBlock
          {...meta("ar-history")}
          purpose="Every request the automatic rejection rejected, newest first: what was asked, when it was submitted, when it was rejected and by which run."
          className="lg:grid-cols-1"
        >
          <HistoryList kinds={kinds} />
        </SettingBlock>
      </SettingsSection>

      <SaveFooter
        dirty={dirty}
        saving={update.isPending}
        onSave={() => void save()}
        onDiscard={() => {
          discard();
          setServerProblem(undefined);
        }}
        saveLabel="Save Auto-Reject Settings"
        disabled={!canChange || !dirty || Boolean(daysProblem)}
        hint={
          !data
            ? "Loading the saved settings…"
            : !canChange && !readOnly
              ? "Company-wide: only a login for all units with the Settings edit right can change it."
              : dirty
                ? daysProblem
                  ? "Unsaved changes - fix the number of days first."
                  : "Unsaved changes - the nightly run keeps the saved settings until you save."
                : undefined
        }
      />
    </div>
  );
}
