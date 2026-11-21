// Geo Attendance -> Live Map -> "Tracking alerts": what the server found and told on its own while employees were On-Duty
// (backend geo_tracking/alerts.py, checked every 2 minutes). Each row is one problem: location turned off, the location
// permission not "all the time", the app restricted in the background, no location received, a missing Geo-Punch, or a
// Geo-Punch reminder; who was told (the employee, then their Department Head when it was not fixed in time), on which channel,
// and how it ended. "Open now" shows what is still wrong; "Last 7 days" the whole log. Read again every minute.
import { useState } from "react";
import { BellRing, CheckCircle2, Route as RouteIcon, Smartphone, UserRound } from "lucide-react";
import { Avatar, Chip } from "@/components/payroll/kit/parts";
import { Card } from "@/components/ui/card";
import { PillTabs } from "@/components/ui/pill-tabs";
import { useTrackingAlerts, type TrackingAlert, type TrackingAlertStage } from "@/lib/api-client/custom-hooks";
import { alertKindTone, alertState, channelLine, headLine, openSummary } from "./alerts";
import { ListSkeleton, LoadError, Note } from "./kit";
import { fmtDateTime, fmtTime } from "./logic";

type View = "open" | "all";
const PAGE = 20;

function StageLine({ stage }: { stage: TrackingAlertStage }) {
  const push = channelLine(stage.push, "push");
  const wa = channelLine(stage.whatsapp, "whatsapp");
  const who =
    stage.stage === "hod" ? `Department Head${stage.recipientName ? ` (${stage.recipientName})` : ""}` : "Employee";
  if (stage.stage === "hod" && stage.push.outcome === "no_head") return null;
  return (
    <p
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-gray-600"
      data-testid={`alert-stage-${stage.stage}`}
    >
      {stage.stage === "hod" ? (
        <UserRound size={12} className="text-violet-600" />
      ) : (
        <Smartphone size={12} className="text-sky-700" />
      )}
      <span className="font-semibold text-gray-800">{who}</span>
      <span>{fmtTime(stage.sentAt)}</span>
      <Chip tone={push.tone} title={push.title} className="!px-1.5 !py-0">
        Phone: {push.text}
      </Chip>
      <Chip tone={wa.tone} title={wa.title} className="!px-1.5 !py-0">
        WhatsApp: {wa.text}
      </Chip>
    </p>
  );
}

function AlertRow({ alert, onOpenJourney }: { alert: TrackingAlert; onOpenJourney?: (id: number) => void }) {
  const state = alertState(alert);
  const head = headLine(alert);
  return (
    <li
      className="flex flex-wrap items-start gap-3 py-3 first:pt-0 last:pb-0"
      data-testid={`tracking-alert-${alert.id}`}
    >
      <Avatar name={alert.employeeName} size={32} />
      <div className="min-w-0 flex-1 basis-64 space-y-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-semibold text-gray-900">{alert.employeeName}</span>
          <span className="font-mono text-[11px] text-gray-500">{alert.employeeCode}</span>
          <Chip tone={alertKindTone(alert.kind)}>{alert.kindLabel}</Chip>
          <Chip tone={state.tone} className="!px-1.5 !py-0">
            {state.label}
          </Chip>
        </p>
        <p className="text-xs text-gray-700">
          {alert.summary}
          <span className="text-gray-500">
            {" "}
            · seen {fmtDateTime(alert.detectedAt)}
            {alert.department ? ` · ${alert.department}` : ""}
          </span>
        </p>
        {alert.stages
          .filter((s) => s.sentAt)
          .map((s) => (
            <StageLine key={s.stage} stage={s} />
          ))}
        {alert.waiting && alert.open && (
          <p className="text-[11px] text-gray-500">The employee is alerted if it lasts past the short wait.</p>
        )}
        {head && (
          <p className="text-[11px] text-gray-500" data-testid={`alert-head-${alert.id}`}>
            {head}
          </p>
        )}
      </div>
      {onOpenJourney && (
        <button
          type="button"
          onClick={() => onOpenJourney(alert.trackId)}
          className="inline-flex shrink-0 items-center gap-1 rounded-xl border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
          aria-label={`Open the journey of ${alert.employeeName}`}
        >
          <RouteIcon size={12} /> Journey
        </button>
      )}
    </li>
  );
}

export default function TrackingAlerts({ onOpenJourney }: { onOpenJourney?: (id: number) => void }) {
  const [view, setView] = useState<View>("open");
  const [size, setSize] = useState(PAGE);
  const query = useTrackingAlerts({ status: view, days: view === "all" ? 7 : undefined, pageSize: size });
  const data = query.data;
  const labels = Object.fromEntries((data?.kinds ?? []).map((k) => [k.key, k.label]));
  return (
    <Card className="space-y-3 rounded-2xl p-4" data-testid="tracking-alerts">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-0.5 rounded-lg bg-amber-50 p-1.5 text-amber-700 ring-1 ring-amber-100">
            <BellRing size={14} />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-gray-900">Tracking alerts</h3>
            <p className="mt-0.5 max-w-2xl text-xs text-gray-500">
              Found automatically while employees are On-Duty. The employee is alerted first; their Department Head is
              told when it is not fixed in time.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {data && (
            <span className="text-xs font-medium text-gray-600" data-testid="tracking-alerts-open" aria-live="polite">
              {openSummary(data.open, data.openByKind, labels)}
            </span>
          )}
          <PillTabs
            items={[
              { value: "open", label: "Open now" },
              { value: "all", label: "Last 7 days" },
            ]}
            value={view}
            onChange={(v) => {
              setView(v as View);
              setSize(PAGE);
            }}
          />
        </div>
      </div>

      {data && !data.settings.alertsEnabled && (
        <Note tone="warn" testId="tracking-alerts-off">
          Automatic tracking alerts are switched off (Tracking Settings). Nothing new is found until they are on again.
        </Note>
      )}

      {query.isLoading ? (
        <ListSkeleton rows={2} height="h-16" />
      ) : query.isError ? (
        <LoadError
          title="The tracking alerts could not be loaded"
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      ) : !data || data.results.length === 0 ? (
        <p
          className="flex items-center justify-center gap-2 rounded-xl border border-dashed px-3 py-6 text-center text-xs text-gray-500"
          data-testid="tracking-alerts-empty"
        >
          <CheckCircle2 size={14} className="text-emerald-600" />
          {view === "open" ? "No tracking problem open right now." : "No tracking alert in the last 7 days."}
        </p>
      ) : (
        <>
          <ul className="divide-y">
            {data.results.map((a) => (
              <AlertRow key={a.id} alert={a} onOpenJourney={onOpenJourney} />
            ))}
          </ul>
          {data.total > data.results.length && (
            <button
              type="button"
              onClick={() => setSize((n) => Math.min(n + PAGE, 100))}
              disabled={size >= 100 || query.isFetching}
              className="w-full rounded-xl border border-dashed px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-60"
              data-testid="tracking-alerts-more"
            >
              Show more ({data.results.length} of {data.total})
            </button>
          )}
        </>
      )}
    </Card>
  );
}
