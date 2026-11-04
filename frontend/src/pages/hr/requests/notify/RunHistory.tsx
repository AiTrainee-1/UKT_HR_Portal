import { useState } from "react";
import { ChevronDown, History, Loader2 } from "lucide-react";
import { Chip, EmptyNote, SectionCard, SkeletonRows } from "@/components/payroll/kit/parts";
import { Button } from "@/components/ui/button";
import {
  useHodReminderRun,
  useHodReminderRuns,
  type HodChannel,
  type HodDelivery,
  type HodRun,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { CHANNEL_LABEL, DELIVERY_LABEL, DELIVERY_TONE, RUN_STATUS, countText, istLabel, runTitle } from "./logic";
import { CHANNEL_ICON } from "./parts";

const CHANNELS: HodChannel[] = ["whatsapp", "email", "push"];
export const RUNS_PAGE_SIZE = 8;

/** One HoD of a run: how each channel went, with the reason when it did not. */
function DeliveryRow({ d }: { d: HodDelivery }) {
  return (
    <li
      className="rounded-xl border border-slate-100 bg-white px-3 py-2.5"
      data-testid={`notify-delivery-${d.managerId}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-bold text-gray-900">
          {d.name} <span className="text-xs font-medium text-gray-500">· {d.pending} pending</span>
        </p>
        <ul className="flex flex-wrap gap-1.5" aria-label={`How the reminder went for ${d.name}`}>
          {CHANNELS.map((c) => {
            const Icon = CHANNEL_ICON[c];
            const x = d[c];
            return (
              <li key={c} data-testid={`notify-delivery-${d.managerId}-${c}`} data-status={x.status}>
                <Chip tone={DELIVERY_TONE[x.status]} icon={Icon} title={x.note || undefined}>
                  {CHANNEL_LABEL[c]}: {DELIVERY_LABEL[x.status]}
                </Chip>
              </li>
            );
          })}
        </ul>
      </div>
      {CHANNELS.some((c) => d[c].note && d[c].status !== "sent") && (
        <p className="mt-1 text-[11px] text-gray-500">
          {CHANNELS.filter((c) => d[c].note && d[c].status !== "sent")
            .map((c) => `${CHANNEL_LABEL[c]}: ${d[c].note}`)
            .join(" · ")}
        </p>
      )}
      {d.text && (
        <details className="mt-1.5 text-xs">
          <summary className="cursor-pointer font-semibold text-blue-600">Message sent</summary>
          <p className="mt-1 whitespace-pre-wrap rounded-lg bg-slate-50 px-3 py-2 text-gray-700">{d.text}</p>
        </details>
      )}
    </li>
  );
}

/** The deliveries of one run, read when the run is opened (and again every 2 s while it is still sending). */
function RunDeliveries({ id }: { id: number }) {
  const q = useHodReminderRun(id);
  if (q.isError) return <p className="text-xs text-red-600">The details could not be loaded.</p>;
  const deliveries = q.data?.deliveries;
  if (!deliveries) return <SkeletonRows rows={2} />;
  if (deliveries.length === 0)
    return <p className="text-xs text-gray-500">Nobody was reminded: no HoD had anything pending.</p>;
  return (
    <ul className="space-y-1.5" data-testid={`notify-deliveries-${id}`}>
      {deliveries.map((d) => (
        <DeliveryRow key={d.managerId} d={d} />
      ))}
    </ul>
  );
}

function RunRow({ run, open, onToggle }: { run: HodRun; open: boolean; onToggle: () => void }) {
  const status = RUN_STATUS[run.status];
  const panel = `notify-run-${run.id}-panel`;
  return (
    <li className="rounded-2xl border border-slate-100 bg-slate-50/50" data-testid={`notify-run-${run.id}`}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={panel}
        className="flex w-full flex-col gap-1.5 px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 sm:flex-row sm:items-center sm:gap-3"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-bold text-gray-900">{istLabel(run.startedAt)}</span>
          <span className="block text-xs text-gray-500">
            {runTitle(run)} · {run.hods} HoD{run.hods === 1 ? "" : "s"}
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-1.5 text-[11px] text-gray-600">
          {CHANNELS.map((c) => (
            <span key={c} className="rounded-full bg-white px-2 py-0.5 ring-1 ring-slate-100">
              {CHANNEL_LABEL[c]}: {countText(run.counts[c])}
            </span>
          ))}
          <Chip tone={status.tone} icon={run.status === "running" ? Loader2 : undefined}>
            {status.label}
          </Chip>
          <ChevronDown
            size={15}
            className={cn("text-gray-400 transition-transform", open && "rotate-180")}
            aria-hidden
          />
        </span>
      </button>
      {open && (
        <div id={panel} className="space-y-2 px-3 pb-3">
          {run.error && (
            <p
              className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700"
              data-testid={`notify-run-${run.id}-error`}
            >
              {run.error}
            </p>
          )}
          <RunDeliveries id={run.id} />
        </div>
      )}
    </li>
  );
}

/** Every run, newest first: when, why (the schedule or someone's Send now), and per HoD how each channel went. */
export default function RunHistory() {
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<number | null>(null);
  const q = useHodReminderRuns(page, RUNS_PAGE_SIZE);
  const data = q.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <SectionCard
      icon={History}
      title="Run history"
      description="Every reminder run, scheduled or sent now. Open one to see, HoD by HoD, what went on each channel."
      testId="notify-history"
    >
      {q.isError && !data ? (
        <p className="text-sm text-red-600">The run history could not be loaded.</p>
      ) : !data ? (
        <SkeletonRows rows={3} />
      ) : data.items.length === 0 ? (
        <EmptyNote
          icon={History}
          title="No reminder has gone out yet"
          hint="Runs appear here as they happen."
          testId="notify-history-empty"
        />
      ) : (
        <div className="space-y-3">
          <ul className="space-y-2">
            {data.items.map((run) => (
              <RunRow
                key={run.id}
                run={run}
                open={openId === run.id}
                onToggle={() => setOpenId((id) => (id === run.id ? null : run.id))}
              />
            ))}
          </ul>
          {pages > 1 && (
            <div className="flex items-center justify-between text-xs text-gray-500">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Newer
              </Button>
              <span>
                Page {page} of {pages} · {data.total} runs
              </span>
              <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
                Older
              </Button>
            </div>
          )}
        </div>
      )}
    </SectionCard>
  );
}
