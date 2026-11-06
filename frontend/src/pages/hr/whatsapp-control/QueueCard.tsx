import { useState, type ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Moon, PauseCircle, PowerOff, Trash2 } from "lucide-react";
import { useClearWhatsAppQueue, useWhatsAppQueue, whatsAppErrorMessage } from "@/lib/api-client/custom-hooks";
import { fmtSendTime, usageLevel } from "./logic";
import { ConfirmDialog } from "./shared";

const BAR = { ok: "bg-emerald-500", near: "bg-amber-500", full: "bg-red-500" } as const;

/** "42 of 200" with a bar that turns amber near the cap and red at it. */
function Meter({
  label,
  used,
  cap,
  sub,
  testId,
}: {
  label: string;
  used: number;
  cap: number;
  sub: string;
  testId: string;
}) {
  const level = usageLevel(used, cap);
  const pct = cap ? Math.min(100, Math.round((used / cap) * 100)) : 0;
  return (
    <div className="rounded-xl bg-slate-50 p-3" data-testid={testId} data-level={level}>
      <p className="text-xs font-medium text-gray-500">{label}</p>
      <p className="text-2xl font-black tabular-nums text-slate-800">
        {used}
        {cap > 0 && <span className="text-sm font-bold text-gray-400"> / {cap}</span>}
      </p>
      <div
        className="mt-1.5 h-1.5 rounded-full bg-slate-200 overflow-hidden"
        title={cap ? `${pct}% of the limit` : undefined}
      >
        <div className={`h-full ${BAR[level]}`} style={{ width: `${pct}%` }} />
      </div>
      <p className="text-[10px] text-gray-400 mt-1">{sub}</p>
    </div>
  );
}

function Tile({
  label,
  value,
  sub,
  tone,
  testId,
}: {
  label: string;
  value: ReactNode;
  sub: string;
  tone: string;
  testId: string;
}) {
  return (
    <div className="rounded-xl bg-slate-50 p-3" data-testid={testId}>
      <p className="text-xs font-medium text-gray-500">{label}</p>
      <p className={`text-2xl font-black tabular-nums ${tone}`}>{value}</p>
      <p className="text-[10px] text-gray-400 mt-0.5">{sub}</p>
    </div>
  );
}

function SmallCount({
  label,
  value,
  sub,
  tone,
  testId,
}: {
  label: string;
  value: number;
  sub: string;
  tone: string;
  testId: string;
}) {
  return (
    <div
      className="rounded-xl border bg-white px-3 py-2 flex items-baseline justify-between gap-2"
      data-testid={testId}
    >
      <div className="min-w-0">
        <p className="text-xs font-semibold text-gray-700">{label}</p>
        <p className="text-[10px] text-gray-400">{sub}</p>
      </div>
      <p className={`text-lg font-black tabular-nums ${value ? tone : "text-gray-300"}`}>{value}</p>
    </div>
  );
}

/** Today's sending queue: what waits, what went out against the limits, and why sending may be held. Polls every 30 s
 *  while it is on screen. */
export default function QueueCard() {
  const { toast } = useToast();
  const { data: q, isLoading, isError } = useWhatsAppQueue();
  const clear = useClearWhatsAppQueue();
  const [asking, setAsking] = useState(false);

  if (isLoading) return <Skeleton className="h-48 rounded-2xl" />;
  if (isError || !q) {
    return (
      <div className="rounded-2xl border bg-white p-4 text-xs text-gray-500" data-testid="wa-queue-card">
        Today's sending queue isn't available from the server right now.
      </div>
    );
  }

  // The server leaves nextSendAt empty when nothing more can go today (a limit is used up, or the day ends first).
  const nextSub = !q.engineEnabled
    ? "the engine is OFF"
    : q.queued === 0
      ? "nothing waiting"
      : !q.nextSendAt
        ? "nothing more goes out today"
        : q.paused
          ? "after the pause"
          : q.inQuietHours
            ? "after quiet hours"
            : q.limits.minGapSeconds
              ? `at least ${q.limits.minGapSeconds} s apart`
              : "next in line";

  const doClear = () =>
    clear.mutate(undefined, {
      onSuccess: (r) => {
        setAsking(false);
        toast({
          title: "Queue cleared",
          description: `${r.cleared} waiting message${r.cleared === 1 ? "" : "s"} will not be sent.`,
        });
      },
      onError: (e) => {
        setAsking(false);
        toast({
          title: "Couldn't clear the queue",
          description: whatsAppErrorMessage(e, "Try again."),
          variant: "destructive",
        });
      },
    });

  return (
    <Card className="border-0 shadow-sm" data-testid="wa-queue-card">
      <CardHeader className="pb-2 flex-row items-start justify-between space-y-0 gap-3">
        <div className="min-w-0">
          <CardTitle className="text-sm font-bold">Today's queue</CardTitle>
          <p className="text-xs text-gray-500 mt-0.5">
            Every message except a login code waits its turn here and goes out within the sending limits. Refreshes
            every 30 seconds.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 text-xs text-red-700 hover:text-red-800 shrink-0"
          onClick={() => setAsking(true)}
          disabled={q.queued === 0 || clear.isPending}
          title={q.queued === 0 ? "Nothing is waiting" : undefined}
          data-testid="wa-clear-queue"
        >
          <Trash2 size={13} /> Clear queue
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {!q.engineEnabled && (
          <div
            data-testid="wa-queue-engine-off"
            className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800"
          >
            <PowerOff size={14} className="mt-0.5 shrink-0" />
            <span>
              The WhatsApp engine is <b>OFF</b>: nothing is sent by WhatsApp until it is turned back on (Feature
              Controls).
            </span>
          </div>
        )}
        {q.paused && (
          <div
            data-testid="wa-queue-paused"
            className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800"
          >
            <PauseCircle size={14} className="mt-0.5 shrink-0" />
            <span>
              <b>Sending is paused.</b> {q.pausedReason || "The server gave no reason."}
            </span>
          </div>
        )}
        {q.inQuietHours && (
          <div
            data-testid="wa-queue-quiet"
            className="flex items-start gap-2 rounded-xl border border-indigo-200 bg-indigo-50 p-3 text-xs text-indigo-800"
          >
            <Moon size={14} className="mt-0.5 shrink-0" />
            <span>
              <b>Quiet hours.</b> Nothing automatic is sent right now, and anything that can't go out today is never
              sent. One-time login codes still go.
            </span>
          </div>
        )}

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Tile
            label="Waiting"
            value={q.queued}
            sub={q.queued === 1 ? "message in the queue" : "messages in the queue"}
            tone={q.queued ? "text-amber-700" : "text-gray-400"}
            testId="wa-queue-queued"
          />
          <Meter
            label="Sent today"
            used={q.sentToday}
            cap={q.limits.maxPerDay}
            sub="daily limit"
            testId="wa-queue-sent-today"
          />
          <Meter
            label="Sent in the last hour"
            used={q.sentLastHour}
            cap={q.limits.maxPerHour}
            sub="hourly limit"
            testId="wa-queue-sent-hour"
          />
          <Tile
            label="Next send"
            value={<span className="text-xl">{q.queued ? fmtSendTime(q.nextSendAt) : "—"}</span>}
            sub={nextSub}
            tone="text-slate-800"
            testId="wa-queue-next"
          />
        </div>
        <div className="grid sm:grid-cols-3 gap-3">
          <SmallCount
            label="Failed today"
            value={q.failedToday}
            sub="not re-sent automatically"
            tone="text-red-600"
            testId="wa-queue-failed"
          />
          <SmallCount
            label="Expired today"
            value={q.expiredToday}
            sub="too late to be useful, never sent"
            tone="text-slate-600"
            testId="wa-queue-expired"
          />
          <SmallCount
            label="Skipped today"
            value={q.skippedToday}
            sub="blocked by a rule, never sent"
            tone="text-orange-600"
            testId="wa-queue-skipped"
          />
        </div>
        {q.limits.maxPerEmployeePerDay > 0 && (
          <p className="text-[10px] text-gray-400">
            At most {q.limits.maxPerEmployeePerDay} automatic message{q.limits.maxPerEmployeePerDay === 1 ? "" : "s"}{" "}
            per employee per day.
          </p>
        )}
      </CardContent>

      <ConfirmDialog
        open={asking}
        title="Clear the queue?"
        confirmLabel="Clear queue"
        destructive
        pending={clear.isPending}
        onConfirm={doClear}
        onCancel={() => setAsking(false)}
        testId="wa-clear-queue-confirm"
      >
        <p>
          The {q.queued} message{q.queued === 1 ? "" : "s"} waiting will <b>not</b> be sent. This can't be undone.
        </p>
        <p>
          They show as Skipped ("Cleared by HR") on the Messages tab. Use it when something queued a burst of messages
          by mistake.
        </p>
      </ConfirmDialog>
    </Card>
  );
}
