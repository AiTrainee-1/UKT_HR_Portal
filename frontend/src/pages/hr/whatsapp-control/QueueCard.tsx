import { useState, type ReactNode } from "react";
import { ListOrdered, Moon, PauseCircle, PowerOff, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useClearWhatsAppQueue, useWhatsAppQueue, whatsAppErrorMessage } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { Notice, Panel } from "./kit";
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
    <div className="rounded-xl bg-muted p-3" data-testid={testId} data-level={level}>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="text-2xl font-bold tabular-nums">
        {used}
        {cap > 0 && <span className="text-sm font-semibold text-muted-foreground"> / {cap}</span>}
      </p>
      <div
        className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-background"
        title={cap ? `${pct}% of the limit` : undefined}
      >
        <div className={`h-full ${BAR[level]}`} style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1 text-[10px] text-muted-foreground">{sub}</p>
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
    <div className="rounded-xl bg-muted p-3" data-testid={testId}>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className={cn("text-2xl font-bold tabular-nums", tone)}>{value}</p>
      <p className="mt-0.5 text-[10px] text-muted-foreground">{sub}</p>
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
    <div className="flex items-baseline justify-between gap-2 rounded-xl border px-3 py-2" data-testid={testId}>
      <div className="min-w-0">
        <p className="text-xs font-semibold">{label}</p>
        <p className="text-[10px] text-muted-foreground">{sub}</p>
      </div>
      <p className={cn("text-lg font-bold tabular-nums", value ? tone : "text-muted-foreground")}>{value}</p>
    </div>
  );
}

/** Today's sending queue: what waits, what went out against the limits, and why sending may be held. Polls every 30 s
 *  while it is on screen. `locked` (View only) keeps Clear queue shut. */
export default function QueueCard({ locked = false }: { locked?: boolean }) {
  const { toast } = useToast();
  const { data: q, isLoading, isError } = useWhatsAppQueue();
  const clear = useClearWhatsAppQueue();
  const [asking, setAsking] = useState(false);

  if (isLoading) return <Skeleton className="h-48 rounded-2xl" />;
  if (isError || !q) {
    return (
      <Notice tone="neutral" testId="wa-queue-card">
        Today's sending queue isn't available from the server right now.
      </Notice>
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
    <Panel
      title="Today's queue"
      icon={ListOrdered}
      testId="wa-queue-card"
      description="Every message except a sign-in code waits its turn here and goes out within the sending limits. Refreshes every 30 seconds."
      actions={
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 text-xs text-red-700 hover:text-red-800 dark:text-red-300"
          onClick={() => setAsking(true)}
          disabled={locked || q.queued === 0 || clear.isPending}
          title={q.queued === 0 ? "Nothing is waiting" : undefined}
          data-testid="wa-clear-queue"
        >
          <Trash2 size={13} /> Clear queue
        </Button>
      }
    >
      <div className="space-y-3">
        {!q.engineEnabled && (
          <Notice tone="bad" icon={PowerOff} testId="wa-queue-engine-off">
            The WhatsApp engine is <b>OFF</b>: nothing is sent by WhatsApp until it is turned back on (above).
          </Notice>
        )}
        {q.paused && (
          <Notice tone="warn" icon={PauseCircle} testId="wa-queue-paused">
            <b>Sending is paused.</b> {q.pausedReason || "The server gave no reason."}
          </Notice>
        )}
        {q.inQuietHours && (
          <Notice tone="info" icon={Moon} testId="wa-queue-quiet">
            <b>Quiet hours.</b> Nothing automatic is sent right now, and anything that can't go out today is never sent.
            Sign-in codes still go.
          </Notice>
        )}

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Tile
            label="Waiting"
            value={q.queued}
            sub={q.queued === 1 ? "message in the queue" : "messages in the queue"}
            tone={q.queued ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground"}
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
            tone=""
            testId="wa-queue-next"
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
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
            sub="held back by a rule, never sent"
            tone="text-orange-600"
            testId="wa-queue-skipped"
          />
        </div>
        {q.limits.maxPerEmployeePerDay > 0 && (
          <p className="text-[10px] text-muted-foreground">
            At most {q.limits.maxPerEmployeePerDay} automatic message{q.limits.maxPerEmployeePerDay === 1 ? "" : "s"}{" "}
            per employee per day.
          </p>
        )}
      </div>

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
    </Panel>
  );
}
