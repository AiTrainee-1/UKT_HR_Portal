import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { History, Loader2, Play, Trash2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  NOTIFY_AUTOMATIONS_KEY,
  NOTIFY_OVERVIEW_KEY,
  NOTIFY_RUNS_KEY,
  useAttendanceNotifyRun,
  useDeleteAttendanceNotifyAutomation,
  useRunAttendanceNotifyAutomation,
  useToggleAttendanceNotifyAutomation,
  type NotifyAutomation,
  type NotifyChannel,
  type NotifyOverview,
  type NotifyRun,
} from "@/lib/api-client/custom-hooks";
import AutomationForm from "./AutomationForm";
import { CHANNEL_LABEL, deliveryText, errorText, nextRunText, runOutcome, type HistoryFilters } from "./logic";
import { ChannelBadge, RunStatusChip } from "./parts";

// One place for what can be done to an automation from anywhere on the page (a channel tab's card, the management
// table, the history): open the form, switch it on / off, run it now (confirmed, then followed until it is over), delete
// it (confirmed; its history stays), and jump to its history.

export type NotifyActions = {
  /** Opens the form for a new automation (`channel` null: the form asks for the channel). */
  create: (channel: NotifyChannel | null) => void;
  edit: (a: NotifyAutomation) => void;
  askDelete: (a: NotifyAutomation) => void;
  askRun: (a: NotifyAutomation) => void;
  toggle: (a: NotifyAutomation, on: boolean) => void;
  /** Follows a run that was just started elsewhere (a retry) until it is over. */
  follow: (run: NotifyRun) => void;
  showHistory: (f: Partial<HistoryFilters>) => void;
  /** The automation whose switch is being saved / whose Run now is starting. */
  togglingId: number | null;
  startingId: number | null;
  /** The run this page started and is following (while it is still sending). */
  live: NotifyRun | null;
};

const Ctx = createContext<NotifyActions | null>(null);

export function useNotifyActions(): NotifyActions {
  const value = useContext(Ctx);
  if (!value) throw new Error("useNotifyActions is used outside NotifyActionsProvider");
  return value;
}

type FormState = { key: number; automation: NotifyAutomation | null; channel: NotifyChannel | null };

export function NotifyActionsProvider({
  overview,
  onShowHistory,
  children,
}: {
  overview: NotifyOverview | undefined;
  onShowHistory: (f: Partial<HistoryFilters>) => void;
  children: ReactNode;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const toggleM = useToggleAttendanceNotifyAutomation();
  const runM = useRunAttendanceNotifyAutomation();
  const deleteM = useDeleteAttendanceNotifyAutomation();

  const [form, setForm] = useState<FormState | null>(null);
  const formKey = useRef(0);
  const [deleting, setDeleting] = useState<NotifyAutomation | null>(null);
  const [running, setRunning] = useState<NotifyAutomation | null>(null);
  const [togglingId, setTogglingId] = useState<number | null>(null);
  const [startingId, setStartingId] = useState<number | null>(null);

  // a run started here is followed (every 3 s) until it is over, then reported once
  const [followId, setFollowId] = useState<number | null>(null);
  const followed = useAttendanceNotifyRun(followId);
  const reported = useRef<number | null>(null);
  useEffect(() => {
    const run = followed.data;
    if (!run || run.status === "running" || reported.current === run.id) return;
    reported.current = run.id;
    toast({
      title:
        run.status === "failed"
          ? "The report could not be sent"
          : run.status === "partial"
            ? "The report was partly sent"
            : run.status === "skipped"
              ? "Nothing was sent"
              : "Report sent",
      description: runOutcome(run),
      variant: run.status === "failed" ? "destructive" : undefined,
    });
    void queryClient.invalidateQueries({ queryKey: [NOTIFY_RUNS_KEY] });
    void queryClient.invalidateQueries({ queryKey: [NOTIFY_AUTOMATIONS_KEY] });
    void queryClient.invalidateQueries({ queryKey: [NOTIFY_OVERVIEW_KEY] });
    setFollowId(null);
  }, [followed.data, queryClient, toast]);

  const follow = useCallback((run: NotifyRun) => {
    reported.current = null;
    setFollowId(run.id);
  }, []);

  const create = useCallback((channel: NotifyChannel | null) => {
    formKey.current += 1;
    setForm({ key: formKey.current, automation: null, channel });
  }, []);
  const edit = useCallback((automation: NotifyAutomation) => {
    formKey.current += 1;
    setForm({ key: formKey.current, automation, channel: automation.channel });
  }, []);

  const toggle = useCallback(
    async (a: NotifyAutomation, on: boolean) => {
      setTogglingId(a.id);
      try {
        const saved = await toggleM.mutateAsync({ id: a.id, isActive: on });
        toast({
          title: on ? `“${a.name}” is on` : `“${a.name}” is off`,
          description: on
            ? saved?.nextRunAt
              ? `Next send: ${nextRunText(saved)} (India time).`
              : "It sends at its next scheduled time."
            : "It sends nothing until it is switched on again. Its history is kept.",
        });
      } catch (err) {
        toast({ title: "Could not switch it", description: errorText(err), variant: "destructive" });
      } finally {
        setTogglingId(null);
      }
    },
    [toast, toggleM],
  );

  const confirmRun = async () => {
    const a = running;
    if (!a) return;
    setStartingId(a.id);
    try {
      const run = await runM.mutateAsync(a.id);
      setRunning(null);
      follow(run);
      toast({ title: `Sending “${a.name}” now`, description: "This page follows it until it is done." });
    } catch (err) {
      setRunning(null);
      toast({ title: `Could not send “${a.name}”`, description: errorText(err), variant: "destructive" });
    } finally {
      setStartingId(null);
    }
  };

  const confirmDelete = async () => {
    const a = deleting;
    if (!a) return;
    try {
      await deleteM.mutateAsync(a.id);
      setDeleting(null);
      toast({ title: `“${a.name}” deleted`, description: "Its execution history is kept under the same name." });
    } catch (err) {
      toast({ title: "Could not delete the automation", description: errorText(err), variant: "destructive" });
    }
  };

  const live = followed.data && followed.data.status === "running" ? followed.data : null;

  const value = useMemo<NotifyActions>(
    () => ({
      create,
      edit,
      askDelete: setDeleting,
      askRun: setRunning,
      toggle: (a, on) => void toggle(a, on),
      follow,
      showHistory: onShowHistory,
      togglingId,
      startingId,
      live,
    }),
    [create, edit, toggle, follow, onShowHistory, togglingId, startingId, live],
  );

  return (
    <Ctx.Provider value={value}>
      {children}

      {form && (
        <AutomationForm
          key={form.key}
          automation={form.automation}
          channel={form.channel}
          overview={overview}
          onClose={() => setForm(null)}
        />
      )}

      <AlertDialog open={running !== null} onOpenChange={(o) => !o && !runM.isPending && setRunning(null)}>
        <AlertDialogContent data-testid="an-run-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Send “{running?.name}” now?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-slate-600">
                <p>
                  The report is made for its usual day and sent at once through{" "}
                  {running ? CHANNEL_LABEL[running.channel] : "its channel"} to{" "}
                  <b className="text-slate-800">{running?.recipientSummary || "its recipients"}</b>.
                </p>
                <p>Its schedule does not change. You can follow the send here and in Execution History.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={runM.isPending}>Cancel</AlertDialogCancel>
            <Button
              onClick={() => void confirmRun()}
              disabled={runM.isPending}
              className="gap-1.5"
              data-testid="an-run-go"
            >
              {runM.isPending ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
              Run now
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && !deleteM.isPending && setDeleting(null)}>
        <AlertDialogContent data-testid="an-delete-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleting?.name}”?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-slate-600">
                <p>It stops sending and is removed from the list. This cannot be undone.</p>
                <p>
                  Its execution history is kept: past sends still show in Execution History under this name. To stop it
                  for a while instead, switch it off.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteM.isPending}>Keep it</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => void confirmDelete()}
              disabled={deleteM.isPending}
              className="gap-1.5"
              data-testid="an-delete-go"
            >
              {deleteM.isPending ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
              Delete automation
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Ctx.Provider>
  );
}

/** The run this page is following, while it sends: what it is, how far it got, and a way to watch it in the history. */
export function LiveRunBanner() {
  const { live, showHistory } = useNotifyActions();
  if (!live) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-2xl border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm text-blue-900"
      role="status"
      data-testid="an-live-run"
    >
      <RunStatusChip status="running" />
      <ChannelBadge channel={live.channel} />
      <span className="font-semibold">{live.automationName || "Automation"}</span>
      <span className="text-xs text-blue-800">{deliveryText(live)}</span>
      <Button
        variant="ghost"
        size="sm"
        className="ml-auto h-8 gap-1.5 text-blue-800"
        onClick={() => showHistory({ automation: live.automationId, run: live.id })}
        data-view-safe
        data-testid="an-live-run-open"
      >
        <History size={14} /> Follow in Execution History
      </Button>
    </div>
  );
}
