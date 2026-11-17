import { FileText, Link2, ListOrdered, Loader2, Monitor, Plug, RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { useWhatsAppConnection, whatsAppErrorMessage, type WhatsAppConnection } from "@/lib/api-client/custom-hooks";
import { employeeCodesText, fmtSendTime, providerBadge, splitProblems } from "./logic";
import { Fact, Notice, Panel, RawJson, Tile } from "./kit";
import { fmtDateTime } from "./shared";

const yesNo = (v: boolean | null) => (v === null ? "—" : v ? "Yes" : "No");
/** "salary_slip" -> "Salary slip" (the check names the type by its key). */
const typeName = (key: string) => (key ? key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, " ") : "—");

function Verdict({ c }: { c: WhatsAppConnection }) {
  const { main, documents } = splitProblems(c.problems, c.documents.problem);
  return (
    <div className="space-y-2">
      {main.length === 0 ? (
        <Notice
          tone="good"
          title={
            c.machine.limitedTo
              ? `All good: WhatsApp can send from this server, to ${employeeCodesText(c.machine.limitedTo)} only.`
              : "All good: WhatsApp can send from this server."
          }
          testId="wa-conn-verdict"
          role="status"
        >
          WAClient answered, the number is linked and the queue is running. Each message type still needs its own switch
          ON (Feature Controls).
        </Notice>
      ) : (
        <Notice
          tone="bad"
          title={
            main.length === 1
              ? "One thing stops WhatsApp from sending"
              : `${main.length} things stop WhatsApp from sending`
          }
          testId="wa-conn-verdict"
          role="alert"
        >
          <ol className="mt-1 list-decimal space-y-1 pl-4" data-testid="wa-conn-problems">
            {main.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ol>
        </Notice>
      )}
      {documents && (
        <Notice tone="neutral" icon={FileText} testId="wa-conn-documents-note">
          <b>Documents only:</b> salary slips, ID cards and letters can't be attached from here. Text messages are not
          affected. {documents}
        </Notice>
      )}
    </div>
  );
}

function ProviderTile({ c }: { c: WhatsAppConnection }) {
  const p = c.provider;
  const badge = p?.ok ? providerBadge(p.state) : null;
  return (
    <Tile
      title="WAClient"
      icon={Plug}
      testId="wa-conn-provider"
      aside={
        badge ? (
          <span data-testid="wa-conn-state" data-state={p?.ok ? p.state : undefined}>
            <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
          </span>
        ) : p && !p.ok ? (
          <StatusBadge tone="danger">No answer</StatusBadge>
        ) : (
          <StatusBadge tone="neutral">Not checked</StatusBadge>
        )
      }
    >
      <Fact label="Linked instance">{c.instance ?? "—"}</Fact>
      <Fact label="WAClient address">{c.apiHost ?? "—"}</Fact>
      {!p && (
        <p className="py-1.5 text-xs text-red-700" data-testid="wa-conn-provider-missing">
          Not asked: the WAClient keys are missing on this server.
        </p>
      )}
      {p?.ok && (
        <>
          <Fact label="Connection open">{yesNo(p.socketLoaded)}</Fact>
          <Fact label="Must link again">
            <span className={p.reloginRequired ? "font-bold text-red-700" : undefined}>{yesNo(p.reloginRequired)}</span>
          </Fact>
        </>
      )}
      {p && !p.ok && (
        <div className="py-1.5 text-xs text-red-700" data-testid="wa-conn-provider-error">
          <p className="font-semibold">{p.error}</p>
          {p.httpStatus !== null && <p className="mt-0.5 text-red-600">HTTP {p.httpStatus}</p>}
        </div>
      )}
    </Tile>
  );
}

function MachineTile({ c }: { c: WhatsAppConnection }) {
  const m = c.machine;
  return (
    <Tile title="This machine" icon={Monitor} testId="wa-conn-machine">
      <Fact label="Development machine">{yesNo(m.developmentMachine)}</Fact>
      <Fact label="Sending allowed">
        <span className={m.sendingAllowed ? "text-emerald-700" : "font-bold text-red-700"}>
          {yesNo(m.sendingAllowed)}
        </span>
      </Fact>
      {m.limitedTo && (
        <div className="py-2">
          <Notice
            tone="warn"
            testId="wa-conn-limited"
            title={`This machine may only message ${employeeCodesText(m.limitedTo)}`}
          >
            Set by WHATSAPP_ONLY_TO_EMPLOYEES. Every other employee is skipped here, whatever the switches say.
          </Notice>
        </div>
      )}
      {m.blockReason && (
        <p className="py-1.5 text-xs font-medium text-red-700" data-testid="wa-conn-block">
          {m.blockReason}
        </p>
      )}
    </Tile>
  );
}

function QueueTile({ c }: { c: WhatsAppConnection }) {
  const q = c.queue;
  return (
    <Tile title="Sending queue" icon={ListOrdered} testId="wa-conn-queue">
      <Fact label="Master switch">
        <span className={q.engineEnabled ? "text-emerald-700" : "font-bold text-red-700"}>
          {q.engineEnabled ? "ON" : "OFF"}
        </span>
      </Fact>
      <Fact label="Paused">
        {q.paused ? <span className="font-bold text-amber-700">Yes: {q.pausedReason ?? "no reason given"}</span> : "No"}
      </Fact>
      <Fact label="Quiet hours now">{yesNo(q.inQuietHours)}</Fact>
      <Fact label="Waiting">{q.queued}</Fact>
      <Fact label="Sent today">{q.sentToday}</Fact>
      <Fact label="Failed today">
        <span className={q.failedToday ? "font-bold text-red-700" : undefined}>{q.failedToday}</span>
      </Fact>
    </Tile>
  );
}

function DocumentsTile({ c }: { c: WhatsAppConnection }) {
  const d = c.documents;
  return (
    <Tile title="Documents" icon={Link2} testId="wa-conn-documents">
      <Fact label="Fetched from">
        <code className="text-[11px]">{d.publicBase || "—"}</code>
      </Fact>
      <p className={`py-1.5 text-xs ${d.problem ? "text-gray-600" : "text-emerald-700"}`}>
        {d.problem
          ? "WAClient can't download files from this address, so documents can't be attached (text messages still go)."
          : "WAClient can download documents from this address."}
      </p>
    </Tile>
  );
}

function LastFailure({ c }: { c: WhatsAppConnection }) {
  const f = c.lastFailure;
  return (
    <Tile title="Last failure" icon={TriangleAlert} testId="wa-conn-last-failure" className="sm:col-span-2">
      {f ? (
        <div className="py-1.5 text-xs">
          <p className="font-semibold text-gray-900">
            {typeName(f.documentType)} · {fmtDateTime(f.at)}
          </p>
          <p className="mt-0.5 text-red-700">{f.error || "No reason recorded."}</p>
        </div>
      ) : (
        <p className="py-1.5 text-xs text-gray-500">No failed message on record.</p>
      )}
    </Tile>
  );
}

/** Configuration -> Connection check: every reason WhatsApp may not be sending, in one place. It asks WAClient live (a few
 *  seconds), so it runs when the tab opens and on "Check again", never by itself. It sends nothing. */
export default function ConnectionPanel() {
  const q = useWhatsAppConnection();
  const c = q.data;
  return (
    <Panel
      title="Connection check"
      icon={Plug}
      testId="wa-connection"
      description="Asks WAClient about the linked number and checks this machine's rules and the queue. Nothing is sent."
      actions={
        <div className="flex items-center gap-2">
          {c?.checkedAt && (
            <span className="text-[11px] text-gray-400" data-testid="wa-conn-checked-at">
              Checked {fmtSendTime(c.checkedAt)}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-xs"
            onClick={() => void q.refetch()}
            disabled={q.isFetching}
            data-testid="wa-conn-recheck"
          >
            {q.isFetching ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            {q.isFetching ? "Checking…" : "Check again"}
          </Button>
        </div>
      }
    >
      {!c ? (
        q.isError ? (
          <Notice tone="bad" title="The connection check could not be run" testId="wa-conn-error" role="alert">
            {whatsAppErrorMessage(q.error, "The server did not answer. Try again.")}
          </Notice>
        ) : (
          <div className="space-y-2" aria-busy data-testid="wa-conn-loading">
            <p className="text-xs text-gray-500">Asking WAClient… this can take a few seconds.</p>
            <Skeleton className="h-14 rounded-xl" />
            <Skeleton className="h-32 rounded-xl" />
          </div>
        )
      ) : (
        <>
          {q.isError && (
            <Notice tone="warn" testId="wa-conn-stale">
              The last check failed ({whatsAppErrorMessage(q.error, "no answer")}); this is the one before it.
            </Notice>
          )}
          <Verdict c={c} />
          <div className="grid gap-3 sm:grid-cols-2">
            <ProviderTile c={c} />
            <MachineTile c={c} />
            <QueueTile c={c} />
            <DocumentsTile c={c} />
            <LastFailure c={c} />
          </div>
          {c.provider && c.provider.raw !== null && (
            <RawJson summary="WAClient's raw answer" value={c.provider.raw} testId="wa-conn-raw" />
          )}
        </>
      )}
    </Panel>
  );
}
