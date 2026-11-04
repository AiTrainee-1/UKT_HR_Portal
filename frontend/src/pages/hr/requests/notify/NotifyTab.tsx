import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Send, ShieldAlert } from "lucide-react";
import { Chip, EmptyNote, SectionCard, SkeletonRows } from "@/components/payroll/kit/parts";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { isRouteViewOnly, useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import {
  HOD_RUNS_KEY,
  HOD_SETTINGS_KEY,
  useHodPending,
  useHodReminderPreview,
  useHodReminderRun,
  useHodReminderSettings,
  useSendHodReminders,
  useUpdateHodReminderSettings,
} from "@/lib/api-client/custom-hooks";
import { ApiError } from "@/lib/api-client/custom-fetch";
import { ErrorState } from "../RequestList";
import {
  CHANNEL_LABEL,
  RUN_STATUS,
  changedFields,
  countText,
  errorText,
  formFrom,
  formProblems,
  formWarnings,
  isCompanyWideRefusal,
  istLabel,
  nextRuns,
  runInProgress,
  runOutcome,
  sameForm,
  sendPlan,
  templateProblem,
  type NotifyForm,
} from "./logic";
import { ChannelsCard, MasterCard, PreviewCard, ReadOnlyNote, SaveDock, ScheduleCard, TemplateCard } from "./parts";
import RunHistory from "./RunHistory";
import SendNowDialog from "./SendNowDialog";

/** The preview asks the server again this long after the last keystroke in the message. */
export const PREVIEW_DEBOUNCE_MS = 600;

/**
 * Notify: the automatic reminder to every HoD with requests waiting for their approval. On / off, the times and days, the
 * channels, the message with a live per-HoD preview, Send now (confirmed, then followed until it is done) and the run history.
 * The schedule is company-wide: a view-only role, or a login limited to one branch, sees all of it read-only.
 */
export default function NotifyTab() {
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const settingsQuery = useHodReminderSettings();
  const settings = settingsQuery.data;
  const update = useUpdateHodReminderSettings();
  const send = useSendHodReminders();

  const saved = useMemo(() => formFrom(settings), [settings]);
  const [form, setForm] = useState<NotifyForm>(saved);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [activeRunId, setActiveRunId] = useState<number | null>(null);

  // the form follows what is saved (a save, a refresh) unless the user is editing it
  const lastSaved = useRef(saved);
  useEffect(() => {
    const previous = lastSaved.current;
    lastSaved.current = saved;
    setForm((current) => (sameForm(current, previous) ? saved : current));
  }, [saved]);

  const viewOnlyRole = isRouteViewOnly(user, "/hr/requests", "requests");
  const readOnly = !settings || !settings.canEdit || viewOnlyRole || refusal !== null;
  const readOnlyText = viewOnlyRole
    ? "View only: your role can look at the reminder settings and the run history, but not change them or send reminders."
    : (refusal ??
      (settings && !settings.canEdit
        ? "View only: the reminder schedule is company-wide (one for every branch). Only an HR login with edit access to Requests that is not limited to one branch can change it or send reminders."
        : null));

  const dirty = !sameForm(form, saved);
  const problems = formProblems(form);
  const warnings = formWarnings(form, settings?.channelStatus);
  const now = new Date();
  const upcoming = nextRuns(now, form.times, form.days);
  const templateDirty = form.template !== saved.template;

  // the preview follows the message on screen, a moment after the typing stops (a broken message keeps the last preview)
  const [previewOf, setPreviewOf] = useState<string | null>(null);
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (!templateDirty) setPreviewOf(null);
      else if (!templateProblem(form.template)) setPreviewOf(form.template);
    }, PREVIEW_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [form.template, templateDirty]);
  const preview = useHodReminderPreview(readOnly ? null : previewOf, { enabled: !!settings });

  // who a Send now reaches: the same board as HoD's (read once the dialog may open)
  const hods = useHodPending({}, { enabled: !!settings && !readOnly });
  const plan = useMemo(
    () => sendPlan(hods.data?.hods ?? [], form.channels, settings?.channelStatus),
    [hods.data, form.channels, settings?.channelStatus],
  );

  // a run started here is followed until it is over, then reported once
  const activeRun = useHodReminderRun(activeRunId);
  const reported = useRef<number | null>(null);
  useEffect(() => {
    const run = activeRun.data;
    if (!run || run.status === "running" || reported.current === run.id) return;
    reported.current = run.id;
    toast({
      title: run.status === "failed" ? "The reminder run failed" : "Reminders sent",
      description: runOutcome(run),
      variant: run.status === "failed" ? "destructive" : undefined,
    });
    void queryClient.invalidateQueries({ queryKey: [HOD_RUNS_KEY] });
    void queryClient.invalidateQueries({ queryKey: [HOD_SETTINGS_KEY] });
    setActiveRunId(null);
  }, [activeRun.data, queryClient, toast]);

  const patch = (p: Partial<NotifyForm>) => setForm((f) => ({ ...f, ...p }));

  const refused = (title: string, err: unknown) => {
    if (isCompanyWideRefusal(err) || (err instanceof ApiError && err.status === 403))
      setRefusal(errorText(err) ?? null);
    toast({ title, description: errorText(err), variant: "destructive" });
  };

  const save = async () => {
    try {
      const next = await update.mutateAsync(changedFields(saved, form));
      const nextForm = formFrom(next);
      lastSaved.current = nextForm;
      setForm(nextForm);
      toast({
        title: "Reminder settings saved",
        description: next.enabled
          ? next.nextRunAt
            ? `Next reminder: ${istLabel(next.nextRunAt)} (India time).`
            : undefined
          : "Automatic reminders are off. Send now still works.",
      });
    } catch (err) {
      refused("Could not save the reminder settings", err);
    }
  };

  const confirmSend = async (managerIds: number[]) => {
    try {
      const run = await send.mutateAsync({ managerIds, channels: form.channels });
      setConfirming(false);
      reported.current = null;
      setActiveRunId(run.id);
      toast({ title: "Sending the reminders", description: "This page follows the run until it is done." });
    } catch (err) {
      setConfirming(false);
      const busy = runInProgress(err);
      if (busy !== null) {
        // somebody (or the schedule) is already sending: follow that run instead of starting a second
        reported.current = null;
        setActiveRunId(busy);
        toast({ title: "A reminder run is already being sent", description: "This page follows it until it is done." });
        return;
      }
      refused("Could not send the reminders", err);
    }
  };

  if (!settings) {
    if (settingsQuery.isError) {
      const notThere = settingsQuery.error instanceof ApiError && settingsQuery.error.status === 404;
      return (
        <Card className="overflow-hidden rounded-2xl" data-testid="notify-tab">
          <CardContent className="p-0">
            {notThere ? (
              <EmptyNote
                icon={ShieldAlert}
                title="The automatic HoD reminders are not available on this server yet"
                hint="They arrive with the next server update."
                className="m-4"
                testId="notify-unavailable"
              />
            ) : (
              <ErrorState onRetry={() => void settingsQuery.refetch()} />
            )}
          </CardContent>
        </Card>
      );
    }
    return (
      <div className="space-y-4" data-testid="notify-tab" aria-busy>
        <SkeletonRows rows={4} />
      </div>
    );
  }

  const live = activeRun.data && activeRun.data.status === "running" ? activeRun.data : null;
  const previewError = preview.isError ? (errorText(preview.error) ?? "The preview could not be made.") : null;

  return (
    <div className="space-y-5" data-testid="notify-tab">
      {readOnlyText && <ReadOnlyNote>{readOnlyText}</ReadOnlyNote>}

      <MasterCard
        form={form}
        onChange={(enabled) => patch({ enabled })}
        readOnly={readOnly}
        nextRunAt={settings.nextRunAt}
        upcoming={upcoming}
        dirty={dirty}
        lastRun={settings.lastRun}
      />

      <div className="grid gap-5 lg:grid-cols-2">
        <ScheduleCard form={form} onChange={patch} readOnly={readOnly} />
        <ChannelsCard
          form={form}
          onChange={(channels) => patch({ channels })}
          status={settings.channelStatus}
          readOnly={readOnly}
        />
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <TemplateCard
          form={form}
          onChange={(template) => patch({ template })}
          defaultTemplate={settings.defaultTemplate}
          problem={templateProblem(form.template)}
          readOnly={readOnly}
        />
        <PreviewCard
          messages={preview.data}
          loading={preview.isFetching}
          error={previewError}
          unsaved={previewOf !== null && !readOnly}
        />
      </div>

      <SaveDock
        dirty={dirty}
        saving={update.isPending}
        problems={dirty ? problems : []}
        warnings={warnings}
        readOnly={readOnly}
        onSave={() => void save()}
        onDiscard={() => setForm(saved)}
      />

      <SectionCard
        icon={Send}
        title="Send now"
        description="Reminds every HoD with something pending right away, on the channels switched on above. You see who gets what before anything goes."
        testId="notify-send"
        actions={
          <Button
            onClick={() => setConfirming(true)}
            disabled={readOnly || send.isPending || live !== null}
            className="gap-1.5"
            data-testid="notify-send-now"
          >
            {live ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            {live ? "Sending…" : "Send now"}
          </Button>
        }
      >
        {live ? (
          <div
            className="flex flex-wrap items-center gap-2 rounded-xl bg-blue-50 px-3 py-2 text-xs text-blue-900"
            role="status"
            data-testid="notify-live-run"
          >
            <Chip tone={RUN_STATUS.running.tone}>{RUN_STATUS.running.label}</Chip>
            {live.hods} HoD{live.hods === 1 ? "" : "s"} ·{" "}
            {(["whatsapp", "email", "push"] as const)
              .map((c) => `${CHANNEL_LABEL[c]}: ${countText(live.counts[c])}`)
              .join(" · ")}
          </div>
        ) : (
          <p className="text-xs text-gray-500">
            {hods.data
              ? `${plan.length} HoD${plan.length === 1 ? "" : "s"} would be reminded now.`
              : readOnly
                ? "Sending is not open to your login."
                : "Counting who would be reminded…"}
          </p>
        )}
      </SectionCard>

      <RunHistory />

      <SendNowDialog
        open={confirming}
        plan={plan}
        loading={!hods.data}
        sending={send.isPending}
        templateUnsaved={templateDirty}
        onClose={() => setConfirming(false)}
        onConfirm={(ids) => void confirmSend(ids)}
      />
    </div>
  );
}
