import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, ArrowRight, Check, Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  downloadAttendanceNotifyPreviewPdf,
  useAttendanceNotifyPreview,
  useSaveAttendanceNotifyAutomation,
  type NotifyAutomation,
  type NotifyChannel,
  type NotifyOverview,
  type NotifyRecipientSet,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { ReportStep, ScheduleStep } from "./FormSteps";
import PreviewPanel from "./PreviewPanel";
import { ChatRecipients, EmailRecipients, WhatsAppRecipients } from "./Recipients";
import {
  CHANNEL_LABEL,
  FORM_STEPS,
  draftBody,
  draftFrom,
  draftProblems,
  draftWarnings,
  emptyDraft,
  errorField,
  errorText,
  firstProblemStep,
  istToday,
  nextRunText,
  pdfFilename,
  stepOfField,
  type FormStep,
  type NotifyDraft,
} from "./logic";
import { ChannelIcon } from "./parts";

/**
 * The automation form, one step at a time: Report (what it holds), Schedule (when), Recipients (who, per channel) and
 * Preview (what would go out now, and the PDF). A step's problems show once it has been left or Save was pressed; Save
 * works from any step and jumps to the first step that still has a problem.
 */
export default function AutomationForm({
  automation,
  channel,
  overview,
  onClose,
}: {
  /** null: a new one. */
  automation: NotifyAutomation | null;
  /** The channel of a new one (null: the form asks). */
  channel: NotifyChannel | null;
  overview: NotifyOverview | undefined;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const save = useSaveAttendanceNotifyAutomation();
  const preview = useAttendanceNotifyPreview();
  const [draft, setDraft] = useState<NotifyDraft>(() =>
    automation ? draftFrom(automation) : emptyDraft(channel ?? "whatsapp"),
  );
  const [step, setStep] = useState<FormStep>("report");
  const [tried, setTried] = useState<Set<FormStep>>(new Set());
  const [serverError, setServerError] = useState<{ step: FormStep | null; message: string } | null>(null);
  const [downloading, setDownloading] = useState(false);

  const today = istToday();
  const problems = useMemo(() => draftProblems(draft, today), [draft, today]);
  const warnings = draftWarnings(draft, {
    channelState: overview?.channels[draft.channel],
    connectedNumber: overview?.settings.connectedNumber,
    now: new Date(),
  });
  const shown = problems.filter((p) => tried.has(p.step));
  const stepProblems = (s: FormStep) => problems.filter((p) => p.step === s);

  const patch = (p: Partial<NotifyDraft>) => {
    setDraft((d) => ({ ...d, ...p }));
    setServerError(null);
  };
  const patchRecipients = (p: Partial<NotifyRecipientSet>) => {
    setDraft((d) => ({ ...d, recipients: { ...d.recipients, ...p } }));
    setServerError(null);
  };

  // the preview is asked for when the step opens, and again on "Refresh preview" (the body it was made of is kept, so a
  // change after it shows the preview as out of date)
  const body = useMemo(() => draftBody(draft), [draft]);
  const bodyKey = JSON.stringify(body);
  const [previewedKey, setPreviewedKey] = useState<string | null>(null);
  const runPreview = () => {
    setPreviewedKey(bodyKey);
    preview.mutate(body);
  };
  const askedOnOpen = useRef<string | null>(null);
  useEffect(() => {
    if (step !== "preview" || askedOnOpen.current === bodyKey) return;
    askedOnOpen.current = bodyKey;
    setPreviewedKey(bodyKey);
    preview.mutate(body);
    // only when the step opens with a form it has not previewed yet
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const goTo = (next: FormStep) => {
    // leaving a step shows its problems from then on
    setTried((t) => new Set(t).add(step));
    setStep(next);
  };
  const index = FORM_STEPS.findIndex((s) => s.value === step);

  const download = async () => {
    setDownloading(true);
    try {
      await downloadAttendanceNotifyPreviewPdf(body, pdfFilename(draft.name, today));
    } catch (err) {
      toast({ title: "Could not make the PDF", description: errorText(err), variant: "destructive" });
    } finally {
      setDownloading(false);
    }
  };

  const submit = async () => {
    setTried(new Set(FORM_STEPS.map((s) => s.value)));
    const stuck = firstProblemStep(problems);
    if (stuck) {
      setStep(stuck);
      return;
    }
    try {
      const saved = await save.mutateAsync({ id: automation?.id ?? null, body });
      toast({
        title: automation ? `“${saved.name}” saved` : `“${saved.name}” created`,
        description: saved.isActive
          ? `Next send: ${nextRunText(saved)} (India time).`
          : "It is switched off: it sends nothing until it is switched on.",
      });
      onClose();
    } catch (err) {
      const where = stepOfField(errorField(err));
      setServerError({ step: where, message: errorText(err) ?? "The automation could not be saved." });
      if (where) setStep(where);
    }
  };

  const title = automation
    ? `Edit “${automation.name}”`
    : `New ${channel ? `${CHANNEL_LABEL[channel]} ` : ""}automation`;
  const previewError = preview.isError ? (errorText(preview.error) ?? "The preview could not be made.") : null;

  return (
    <Dialog open onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent
        className="flex max-h-[94vh] max-w-4xl flex-col gap-0 overflow-hidden bg-white p-0"
        data-testid="an-form"
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader className="space-y-1 border-b border-slate-100 px-6 pb-4 pt-5 text-left">
          <DialogTitle className="flex items-center gap-2.5 pr-8 text-lg font-black text-slate-900">
            <ChannelIcon channel={draft.channel} size={15} />
            <span className="min-w-0 truncate">{title}</span>
          </DialogTitle>
          <DialogDescription className="text-xs text-slate-500">
            An attendance report sent through {CHANNEL_LABEL[draft.channel]} on a schedule. Nothing is sent until it is
            saved and its time comes.
          </DialogDescription>
          <ol className="flex flex-wrap gap-1.5 pt-2" aria-label="Steps" data-testid="an-form-steps">
            {FORM_STEPS.map((s, i) => {
              const on = s.value === step;
              const bad = tried.has(s.value) && stepProblems(s.value).length > 0;
              const done = tried.has(s.value) && !bad && !on;
              return (
                <li key={s.value}>
                  <button
                    type="button"
                    onClick={() => goTo(s.value)}
                    aria-current={on ? "step" : undefined}
                    className={cn(
                      "inline-flex items-center gap-2 rounded-xl border px-3 py-1.5 text-left text-xs font-semibold transition-colors",
                      on
                        ? "border-slate-900 bg-slate-900 text-white"
                        : bad
                          ? "border-red-200 bg-red-50 text-red-700"
                          : "border-slate-200 bg-white text-slate-600 hover:border-slate-300",
                    )}
                    data-view-safe
                    data-testid={`an-form-step-${s.value}`}
                  >
                    <span
                      className={cn(
                        "flex h-5 w-5 items-center justify-center rounded-full text-[10px]",
                        on
                          ? "bg-white text-slate-900"
                          : done
                            ? "bg-emerald-100 text-emerald-700"
                            : "bg-slate-100 text-slate-600",
                      )}
                    >
                      {done ? <Check size={11} /> : bad ? "!" : i + 1}
                    </span>
                    <span>
                      {s.label}
                      <span className={cn("hidden font-normal sm:block", on ? "text-slate-300" : "text-slate-400")}>
                        {s.hint}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {serverError && (serverError.step === null || serverError.step === step) && (
            <p
              className="mb-4 flex items-start gap-1.5 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
              role="alert"
              data-testid="an-form-server-error"
            >
              <AlertTriangle size={15} className="mt-0.5 shrink-0" /> {serverError.message}
            </p>
          )}
          {step === "report" && (
            <ReportStep
              draft={draft}
              onChange={patch}
              problems={shown}
              channelLocked={!!automation || channel !== null}
            />
          )}
          {step === "schedule" && <ScheduleStep draft={draft} onChange={patch} problems={shown} today={today} />}
          {step === "recipients" && (
            <div className="space-y-3">
              {draft.channel === "whatsapp" && (
                <WhatsAppRecipients
                  value={draft.recipients}
                  onChange={patchRecipients}
                  connectedNumber={overview?.settings.connectedNumber ?? ""}
                />
              )}
              {draft.channel === "email" && (
                <EmailRecipients
                  value={draft.recipients}
                  onChange={patchRecipients}
                  emailFormat={draft.emailFormat}
                  attachPdf={draft.attachPdf}
                  subject={draft.subject}
                  onEmailChange={patch}
                />
              )}
              {draft.channel === "chat" && <ChatRecipients value={draft.recipients} onChange={patchRecipients} />}
              {shown
                .filter((p) => p.step === "recipients")
                .map((p) => (
                  <p key={p.message} role="alert" className="text-xs font-medium text-red-600">
                    {p.message}
                  </p>
                ))}
            </div>
          )}
          {step === "preview" && (
            <PreviewPanel
              draft={draft}
              preview={preview.data}
              loading={preview.isPending}
              error={previewError}
              stale={previewedKey !== null && previewedKey !== bodyKey}
              onRefresh={runPreview}
              onDownload={() => void download()}
              downloading={downloading}
            />
          )}
        </div>

        <div className="space-y-2 border-t border-slate-100 bg-slate-50 px-6 py-3">
          {warnings.length > 0 && step !== "report" && (
            <ul className="space-y-0.5" data-testid="an-form-warnings">
              {warnings.map((w) => (
                <li key={w} className="flex items-start gap-1.5 text-[11px] text-amber-800">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {w}
                </li>
              ))}
            </ul>
          )}
          {shown.length > 0 && (
            <p className="text-[11px] font-medium text-red-600" data-testid="an-form-problems">
              {shown.length === 1 ? "1 thing to fix" : `${shown.length} things to fix`} before saving:{" "}
              {shown.map((p) => p.message).join(" ")}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="ghost" onClick={onClose} disabled={save.isPending} data-view-safe>
              Cancel
            </Button>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {index > 0 && (
                <Button
                  type="button"
                  variant="outline"
                  className="gap-1.5"
                  onClick={() => goTo(FORM_STEPS[index - 1].value)}
                  data-view-safe
                  data-testid="an-form-back"
                >
                  <ArrowLeft size={14} /> Back
                </Button>
              )}
              {index < FORM_STEPS.length - 1 && (
                <Button
                  type="button"
                  variant={automation ? "outline" : "default"}
                  className="gap-1.5"
                  onClick={() => goTo(FORM_STEPS[index + 1].value)}
                  data-view-safe
                  data-testid="an-form-next"
                >
                  Next: {FORM_STEPS[index + 1].label} <ArrowRight size={14} />
                </Button>
              )}
              {(automation || index === FORM_STEPS.length - 1) && (
                <Button
                  type="button"
                  className="gap-1.5"
                  onClick={() => void submit()}
                  disabled={save.isPending}
                  data-testid="an-form-save"
                >
                  {save.isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                  {automation ? "Save changes" : "Save automation"}
                </Button>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
