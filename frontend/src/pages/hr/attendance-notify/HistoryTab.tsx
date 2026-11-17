import { useEffect, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { ChevronDown, ChevronLeft, ChevronRight, History, Loader2, RotateCcw, X } from "lucide-react";
import { EmptyNote, SectionCard, SkeletonRows } from "@/components/payroll/kit/parts";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  useAttendanceNotifyAutomations,
  useAttendanceNotifyRun,
  useAttendanceNotifyRuns,
  useRetryAttendanceNotifyRun,
  type NotifyChannel,
  type NotifyRun,
  type NotifyRunStatus,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { useNotifyActions } from "./actions";
import {
  CHANNEL_LABEL,
  DELIVERY_KIND_LABEL,
  canRetry,
  countTotal,
  deliveryText,
  errorText,
  historyFiltersFromSearch,
  historySearch,
  phoneLabel,
  rangeLabel,
  runTitle,
  whenText,
  type HistoryFilters,
} from "./logic";
import { CategoryChip, ChannelIcon, DeliveryStatusChip, RunStatusChip, Segmented } from "./parts";

/** What happened to each recipient of a run, and "Retry failed" when some did not get it. */
function RunDetails({ run: listed }: { run: NotifyRun }) {
  const { toast } = useToast();
  const actions = useNotifyActions();
  const retry = useRetryAttendanceNotifyRun();
  // the run itself is read again when opened (and every 3 s while it sends); the list's copy shows meanwhile
  const fresh = useAttendanceNotifyRun(listed.id);
  const run = fresh.data ?? listed;

  const retryFailed = async () => {
    try {
      const next = await retry.mutateAsync(run.id);
      actions.follow(next);
      toast({
        title: `Sending the ${run.failed} failed again`,
        description: "A new run is made for them; this page follows it until it is done.",
      });
    } catch (err) {
      toast({ title: "Could not send them again", description: errorText(err), variant: "destructive" });
    }
  };

  return (
    <div className="space-y-3 px-3 pb-3" data-testid={`an-run-${run.id}-details`}>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl bg-white p-3 text-xs ring-1 ring-slate-100 md:grid-cols-4">
        <div>
          <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Report for</dt>
          <dd className="font-medium text-slate-800">{rangeLabel(run.reportFrom, run.reportTo)}</dd>
        </div>
        <div>
          <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Employees</dt>
          <dd className="font-medium text-slate-800">{run.employees.toLocaleString("en-IN")}</dd>
        </div>
        <div>
          <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Started</dt>
          <dd className="font-medium text-slate-800">{whenText(run.startedAt)}</dd>
        </div>
        <div>
          <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Finished</dt>
          <dd className="font-medium text-slate-800">
            {run.finishedAt ? whenText(run.finishedAt) : run.status === "running" ? "Still sending" : "—"}
          </dd>
        </div>
      </dl>
      {countTotal(run.counts) > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {(Object.keys(run.counts) as (keyof typeof run.counts)[])
            .filter((c) => run.counts[c] > 0)
            .map((c) => (
              <CategoryChip key={c} category={c} count={run.counts[c]} />
            ))}
        </div>
      )}
      {run.error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700" data-testid={`an-run-${run.id}-error`}>
          {run.error}
        </p>
      )}

      {run.deliveries.length === 0 ? (
        <p className="text-xs text-slate-500">
          {run.status === "running"
            ? "Getting the recipients ready…"
            : run.status === "skipped"
              ? "Nothing was sent: nobody was in the chosen categories (Skip when empty)."
              : "No recipient was reached."}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-100 bg-white">
          <table className="w-full text-left text-xs" data-testid={`an-run-${run.id}-deliveries`}>
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2 font-semibold">Recipient</th>
                <th className="px-3 py-2 font-semibold">Status</th>
                <th className="px-3 py-2 font-semibold">Note</th>
                <th className="px-3 py-2 font-semibold">Tries</th>
                <th className="px-3 py-2 font-semibold">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {run.deliveries.map((d) => (
                <tr key={d.id} data-testid={`an-delivery-${d.id}`} data-status={d.status}>
                  <td className="px-3 py-2">
                    <span className="block font-semibold text-slate-900">
                      {d.label ||
                        (d.kind === "number" || d.kind === "connected" ? phoneLabel(d.recipient) : d.recipient)}
                    </span>
                    <span className="block text-[11px] text-slate-500">
                      {DELIVERY_KIND_LABEL[d.kind]}
                      {d.label && d.recipient && d.kind !== "chat"
                        ? ` · ${d.kind === "number" || d.kind === "connected" ? phoneLabel(d.recipient) : d.recipient}`
                        : ""}
                      {d.kind === "chat" && d.status === "sent" && d.label.startsWith("Company") && (
                        <>
                          {" · "}
                          <a
                            href={`/hr/chat?channel=${d.recipient}`}
                            className="font-semibold text-indigo-700 underline"
                            data-testid={`an-delivery-open-chat-${d.id}`}
                          >
                            Open in Chat
                          </a>
                        </>
                      )}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <DeliveryStatusChip status={d.status} />
                  </td>
                  <td className={cn("px-3 py-2", d.status === "failed" ? "text-red-700" : "text-slate-600")}>
                    {d.note || "—"}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-slate-600">{d.attempts}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-slate-500">{whenText(d.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canRetry(run) && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={() => void retryFailed()}
            disabled={retry.isPending}
            aria-label={`Retry failed: send the ${run.failed} failed again`}
            data-testid={`an-run-${run.id}-retry`}
          >
            {retry.isPending ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
            Retry failed ({run.failed})
          </Button>
          <span className="text-[11px] text-slate-500">Only the recipients that failed get it again.</span>
        </div>
      )}
    </div>
  );
}

function RunRow({ run, open, onToggle }: { run: NotifyRun; open: boolean; onToggle: () => void }) {
  const panel = `an-run-${run.id}-panel`;
  return (
    <li
      className={cn("rounded-2xl border bg-slate-50", run.status === "failed" ? "border-red-100" : "border-slate-100")}
      data-testid={`an-run-${run.id}`}
      data-status={run.status}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={panel}
        className="flex w-full flex-col gap-2 px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 sm:flex-row sm:items-center sm:gap-3"
        data-view-safe
        data-testid={`an-run-${run.id}-toggle`}
      >
        <ChannelIcon channel={run.channel} size={14} className="hidden sm:inline-flex" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-bold text-slate-900">
            {run.automationName || "Automation"}
            {run.automationId === null && (
              <span className="ml-1.5 text-[11px] font-medium text-slate-400">(deleted)</span>
            )}
          </span>
          <span className="block text-xs text-slate-500">
            {whenText(run.startedAt)} · {runTitle(run)} · {CHANNEL_LABEL[run.channel]}
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-600">
          <span className="rounded-full bg-white px-2 py-0.5 ring-1 ring-slate-100">
            {run.employees.toLocaleString("en-IN")} employee{run.employees === 1 ? "" : "s"}
          </span>
          <span className="rounded-full bg-white px-2 py-0.5 ring-1 ring-slate-100">{deliveryText(run)}</span>
          <RunStatusChip status={run.status} />
          <ChevronDown
            size={15}
            className={cn("text-slate-400 transition-transform", open && "rotate-180")}
            aria-hidden
          />
        </span>
      </button>
      {open && (
        <div id={panel}>
          <RunDetails run={run} />
        </div>
      )}
    </li>
  );
}

/** A run asked for by the address (a jump from "View errors") that is not on the page being shown. */
function PinnedRun({ id, onClose }: { id: number; onClose: () => void }) {
  const q = useAttendanceNotifyRun(id);
  if (q.isError) return <p className="text-xs text-red-600">That run could not be loaded.</p>;
  if (!q.data) return <SkeletonRows rows={1} />;
  return (
    <ul className="space-y-2" data-testid="an-run-pinned">
      <RunRow run={q.data} open onToggle={onClose} />
    </ul>
  );
}

/** Every send of every automation, newest first: open one to see each recipient, retry the failed ones. */
export default function HistoryTab() {
  const [location, navigate] = useLocation();
  const search = useSearch();
  const filters = historyFiltersFromSearch(search);
  const setFilters = (f: Partial<HistoryFilters>) =>
    navigate(`${location}?${historySearch(search, { ...filters, run: null, page: 1, ...f })}`, { replace: true });

  const q = useAttendanceNotifyRuns({
    automation: filters.automation,
    channel: filters.channel,
    status: filters.status,
    page: filters.page,
  });
  const automations = useAttendanceNotifyAutomations({});
  const [openIds, setOpenIds] = useState<Set<number>>(() => new Set(filters.run ? [filters.run] : []));
  useEffect(() => {
    if (filters.run) setOpenIds((s) => new Set(s).add(filters.run as number));
  }, [filters.run]);
  const toggle = (id: number) =>
    setOpenIds((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const data = q.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const pinned = filters.run && data && !data.items.some((r) => r.id === filters.run) ? filters.run : null;
  const filtered = !!(filters.automation || filters.channel || filters.status);
  const known = automations.data ?? [];
  const pickedMissing = filters.automation && !known.some((a) => a.id === filters.automation);

  return (
    <SectionCard
      icon={History}
      title={`Execution history${data ? ` (${data.total.toLocaleString("en-IN")})` : ""}`}
      description="Every send, scheduled or run by hand, newest first. Open one to see what happened to each recipient."
      testId="an-history"
    >
      <div className="mb-3 flex flex-wrap items-center gap-2" data-testid="an-history-filters">
        <select
          value={filters.automation ?? ""}
          onChange={(e) => setFilters({ automation: e.target.value ? Number(e.target.value) : null })}
          className="h-9 max-w-[16rem] rounded-lg border border-slate-200 bg-white px-2 text-xs"
          aria-label="Automation"
          data-testid="an-history-automation"
        >
          <option value="">Every automation</option>
          {pickedMissing && <option value={filters.automation ?? ""}>Automation #{filters.automation}</option>}
          {known.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} ({CHANNEL_LABEL[a.channel]})
            </option>
          ))}
        </select>
        <Segmented<NotifyChannel | "all">
          options={[
            { value: "all", label: "Every channel" },
            { value: "whatsapp", label: CHANNEL_LABEL.whatsapp },
            { value: "email", label: CHANNEL_LABEL.email },
            { value: "chat", label: CHANNEL_LABEL.chat },
          ]}
          value={filters.channel ?? "all"}
          onChange={(v) => setFilters({ channel: v === "all" ? null : v })}
          ariaLabel="Channel"
          testId="an-history-channel"
        />
        <Segmented<NotifyRunStatus | "all">
          options={[
            { value: "all", label: "Any result" },
            { value: "running", label: "Sending" },
            { value: "done", label: "Sent" },
            { value: "partial", label: "Partly sent" },
            { value: "failed", label: "Failed" },
            { value: "skipped", label: "Skipped" },
          ]}
          value={filters.status ?? "all"}
          onChange={(v) => setFilters({ status: v === "all" ? null : v })}
          ariaLabel="Result"
          testId="an-history-status"
        />
        {filtered && (
          <Button
            size="sm"
            variant="ghost"
            className="h-8 gap-1 text-slate-600"
            onClick={() => setFilters({ automation: null, channel: null, status: null })}
            data-view-safe
            data-testid="an-history-clear"
          >
            <X size={13} /> Clear filters
          </Button>
        )}
      </div>

      {pinned && (
        <div className="mb-3">
          <PinnedRun id={pinned} onClose={() => setFilters({ run: null, page: filters.page })} />
        </div>
      )}

      {q.isError && !data ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
          The history could not be loaded: {errorText(q.error) ?? "the server did not answer"}.
          <Button size="sm" variant="outline" onClick={() => void q.refetch()} data-view-safe>
            Try again
          </Button>
        </div>
      ) : !data ? (
        <SkeletonRows rows={3} />
      ) : data.items.length === 0 ? (
        <EmptyNote
          icon={History}
          title={filtered ? "No send matches these filters" : "Nothing has been sent yet"}
          hint={
            filtered ? "Clear a filter to see more." : "Sends appear here as they happen, scheduled or run by hand."
          }
          testId="an-history-empty"
        />
      ) : (
        <div className="space-y-3">
          <ul className="space-y-2" data-testid="an-runs">
            {data.items.map((run) => (
              <RunRow key={run.id} run={run} open={openIds.has(run.id)} onToggle={() => toggle(run.id)} />
            ))}
          </ul>
          {pages > 1 && (
            <div className="flex items-center justify-end gap-2 text-xs text-slate-500">
              Page {data.page} of {pages}
              <Button
                size="sm"
                variant="outline"
                className="h-8 w-8 p-0"
                disabled={data.page <= 1}
                onClick={() => setFilters({ page: data.page - 1 })}
                aria-label="Newer sends"
                data-view-safe
                data-testid="an-history-prev"
              >
                <ChevronLeft size={14} />
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 w-8 p-0"
                disabled={data.page >= pages}
                onClick={() => setFilters({ page: data.page + 1 })}
                aria-label="Older sends"
                data-view-safe
                data-testid="an-history-next"
              >
                <ChevronRight size={14} />
              </Button>
            </div>
          )}
        </div>
      )}
    </SectionCard>
  );
}
