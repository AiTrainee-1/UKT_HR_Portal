import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  FileText,
  Hand,
  Hourglass,
  Landmark,
  Link2,
  ListChecks,
  Loader2,
  Lock,
  Mail,
  RotateCcw,
  Send,
  ShieldCheck,
  Stamp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  getSettlementMonthQueryKey,
  useSettlementAuditorDone,
  useSettlementComplete,
  useSettlementFinalize,
  useSettlementForward,
  useSettlementResubmitAuditor,
  useSettlementResubmitMd,
  useSettlementSendAccounts,
  useSettlementSendAuditor,
  type SettlementAuditorLink,
  type SettlementBatch,
  type SettlementRecipients,
} from "@/lib/api-client/custom-hooks/settlement-automation";
import { cn } from "@/lib/utils";
import type { ExportCompany } from "../../attendance/export";
import { serverError } from "../logic";
import { Chip } from "../parts";
import { formatDateTime, formatMoney } from "../shared";
import { AuditorChangesReview, FinalizeReview, NoteActionDialog } from "./dialogs";
import { buildAuditorFiles, buildBatchBankFile, saveFile } from "./files";
import { reworkProgress } from "./focus";
import {
  AUDITOR_DECISION_LABEL,
  STAGE_TITLE,
  advanceIdsOf,
  auditorReview,
  batchBankRows,
  batchBankTotal,
  batchMissingBank,
  finalReview,
  linkStateText,
  requestsText,
  workflowRefusal,
} from "./logic";
import { roundedTotalOf } from "./rounding";

const SETTINGS_LINK = "/hr/settings?tab=settlement";

type Refusal = ReturnType<typeof workflowRefusal>;

type Props = {
  batch: SettlementBatch;
  recipients: SettlementRecipients;
  /** This login may move the workflow (the Loan & Advance edit right, a login for all units). */
  may: boolean;
  /** Why it may not (shown instead of the buttons). */
  mayNotReason?: string;
  /** Finalize decides the advances: it needs the approval rights of every type in the batch. */
  finalizeBlocked?: string | null;
  company: ExportCompany;
  /** Opens the Requests tab (where HR answers the reviewer request by request). */
  onOpenRequests?: () => void;
};

function Recipients({ to, cc, testId }: { to: string[]; cc: string[]; testId: string }) {
  return (
    <div className="space-y-1 text-[12px]" data-testid={testId}>
      <p className="flex flex-wrap items-center gap-1">
        <span className="w-7 font-semibold text-slate-500">To</span>
        {to.length > 0 ? (
          to.map((e) => (
            <span key={e} className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-slate-700">
              {e}
            </span>
          ))
        ) : (
          <span className="text-slate-400">nobody yet</span>
        )}
      </p>
      {cc.length > 0 && (
        <p className="flex flex-wrap items-center gap-1">
          <span className="w-7 font-semibold text-slate-500">CC</span>
          {cc.map((e) => (
            <span key={e} className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-slate-600">
              {e}
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

function NoRecipients({ who, testId }: { who: string; testId: string }) {
  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"
      role="status"
      data-testid={testId}
    >
      <AlertTriangle size={14} className="shrink-0" aria-hidden />
      <span>No {who} e-mail address is set.</span>
      <Link href={SETTINGS_LINK} className="font-semibold text-amber-900 underline">
        Add it in Settings, Loan &amp; Advance
      </Link>
    </div>
  );
}

function RefusalNote({ refusal, testId }: { refusal: Refusal | null; testId: string }) {
  if (!refusal) return null;
  return (
    <div
      className="space-y-1 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800"
      role="alert"
      data-testid={testId}
      data-code={refusal.code ?? undefined}
    >
      <p className="font-semibold">{refusal.text}</p>
      {refusal.hint && <p>{refusal.hint}</p>}
      {refusal.code === "email_off" && (
        <Link href="/hr/gmail-control" className="font-semibold underline">
          Open Gmail Control
        </Link>
      )}
      {refusal.code === "no_recipient" && (
        <Link href={SETTINGS_LINK} className="font-semibold underline">
          Open Settings, Loan &amp; Advance
        </Link>
      )}
    </div>
  );
}

function Progress({ text, testId }: { text: string | null; testId: string }) {
  if (!text) return null;
  return (
    <p
      className="flex items-center gap-2 rounded-xl border border-indigo-100 bg-indigo-50 px-3 py-2 text-xs font-medium text-indigo-800"
      role="status"
      aria-live="polite"
      data-testid={testId}
    >
      <Loader2 size={13} className="animate-spin" aria-hidden /> {text}
    </p>
  );
}

function Facts({ children }: { children: ReactNode }) {
  return <dl className="grid gap-x-6 gap-y-1 text-[12px] sm:grid-cols-2">{children}</dl>;
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 text-slate-400">{label}</dt>
      <dd className="min-w-0 font-medium text-slate-700">{value}</dd>
    </div>
  );
}

const stamp = (at: string | null, by: string | null) =>
  [at ? formatDateTime(at) : "", by ? `by ${by}` : ""].filter(Boolean).join(" ") || "-";

/** Who finalized the settlement and when (owner 2026-11-27: "Finalized by the MD (direct to auditor)" when the MD sent
 *  it straight to the auditor and HR Final Settlement was skipped). */
const finalizedText = (batch: SettlementBatch) =>
  batch.finalizedVia === "md"
    ? `Finalized by the MD (direct to auditor)${batch.finalizedAt ? ` · ${stamp(batch.finalizedAt, batch.finalizedBy)}` : ""}`
    : stamp(batch.finalizedAt, batch.finalizedBy);

/** The auditor's review link as HR follows it (2026-11-27): to whom and when it went, until when it works (or that it
 *  expired / was replaced), when the auditor opened it and how often, and whether they answered. Never the link itself. */
function LinkStatus({ link }: { link: SettlementAuditorLink | null }) {
  if (!link) {
    return (
      <p className="rounded-xl bg-slate-50 p-3 text-xs text-slate-500" data-testid="auto-link-none">
        No review link has been sent for this batch yet.
      </p>
    );
  }
  const state = linkStateText(link);
  return (
    <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50/70 p-3" data-testid="auto-link-status">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[11.5px] font-semibold text-slate-500">
          <Link2 size={12} aria-hidden /> Review link
        </p>
        <span data-testid="auto-link-state">
          <Chip tone={state.tone}>{state.text}</Chip>
        </span>
      </div>
      <Facts>
        <Fact label="Sent to" value={link.sentTo.join(", ") || "-"} />
        <Fact label="Sent" value={stamp(link.createdAt, link.createdBy)} />
        <Fact
          label={link.expired && !link.submittedAt ? "Expired" : "Valid until"}
          value={
            <span className={cn(link.expired && !link.submittedAt && "text-red-700")}>
              {formatDateTime(link.expiresAt)}
            </span>
          }
        />
        <Fact
          label="Opened"
          value={
            <span data-testid="auto-link-opened">
              {link.openCount > 0
                ? `${link.openCount} ${link.openCount === 1 ? "time" : "times"} · first ${formatDateTime(
                    link.firstOpenedAt,
                  )}${link.lastOpenedAt && link.openCount > 1 ? ` · last ${formatDateTime(link.lastOpenedAt)}` : ""}`
                : "Not opened yet"}
            </span>
          }
        />
        <Fact
          label="Answered"
          value={
            <span data-testid="auto-link-answered">
              {link.submittedAt
                ? `${formatDateTime(link.submittedAt)}${link.decision ? ` · ${AUDITOR_DECISION_LABEL[link.decision]}` : ""}`
                : "Not yet"}
            </span>
          }
        />
      </Facts>
    </div>
  );
}

/** The MD's / the auditor's review round (1 = the first; 2 and on = a revised settlement after HR's rework). */
const mdRoundOf = (batch: SettlementBatch) => batch.mdRound ?? batch.flow?.mdRound ?? 1;
const auditorRoundOf = (batch: SettlementBatch) => batch.auditorRound ?? batch.flow?.auditorRound ?? 1;

/** How the audit ended, for the stages after it. */
function auditOutcomeText(batch: SettlementBatch): string {
  const a = batch.auditor;
  const round = auditorRoundOf(batch);
  const revised = round > 1 ? ` (the revised settlement, round ${round})` : "";
  if (a.outcome === "approved")
    return `Approved by the auditor${revised}${a.submittedAt ? ` on ${formatDateTime(a.submittedAt)}` : ""}`;
  if (a.outcome === "changes")
    return `Returned to HR for rework by the auditor${a.submittedAt ? ` on ${formatDateTime(a.submittedAt)}` : ""}`;
  if (a.outcome === "confirmed_by_hr") return `Confirmed by HR by hand ${stamp(a.confirmedAt, a.confirmedBy)}`;
  return stamp(a.confirmedAt, a.confirmedBy);
}

/** A line that says the review is a later round (a revised settlement after HR's rework). */
function RoundNote({ text, testId }: { text: string; testId: string }) {
  return (
    <p
      className="flex items-start gap-2 rounded-xl border border-violet-200 bg-violet-50 px-3 py-2 text-[13px] font-medium text-violet-900"
      data-testid={testId}
    >
      <RotateCcw size={14} className="mt-0.5 shrink-0" aria-hidden />
      {text}
    </p>
  );
}

/** The reviewer's words to HR at a rework stage: the MD's instructions / the auditor's note. */
function ReviewerNote({ title, note, empty, testId }: { title: string; note: string; empty: string; testId: string }) {
  return (
    <div
      className="rounded-xl border border-amber-200 bg-amber-50/80 px-3 py-2 text-[13px] text-amber-950"
      data-testid={testId}
    >
      <p className="text-[11.5px] font-semibold text-amber-800">{title}</p>
      <p className={cn(!note && "text-amber-800/80")}>{note || empty}</p>
    </div>
  );
}

/**
 * What to do now on the batch shown (owner 2026-11-26): one card per stage with the facts HR needs and the step's own
 * buttons, driven by the batch's `actions` flags. Every step is HR's own click; nothing moves on by itself, and a step
 * that sends an e-mail moves on only when the e-mail was sent.
 */
export default function StagePanel({
  batch,
  recipients,
  may,
  mayNotReason,
  finalizeBlocked,
  company,
  onOpenRequests,
}: Props) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const forward = useSettlementForward();
  const finalize = useSettlementFinalize();
  const sendAuditor = useSettlementSendAuditor();
  const auditorDone = useSettlementAuditorDone();
  const resubmitMd = useSettlementResubmitMd();
  const resubmitAuditor = useSettlementResubmitAuditor();
  const sendAccounts = useSettlementSendAccounts();
  const complete = useSettlementComplete();

  const [dialog, setDialog] = useState<
    "forward" | "finalize" | "proceed" | "resubmit_md" | "resubmit_auditor" | "complete" | null
  >(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [preparing, setPreparing] = useState<string | null>(null);

  const act = batch.actions;
  const period = `Batch ${batch.number}`;
  const busy = progress !== null;
  const refetchMonth = () =>
    queryClient.invalidateQueries({ queryKey: getSettlementMonthQueryKey(batch.month, batch.year, batch.advanceType) });

  // ── Send to Auditor: a secure review link, with the finalized report (PDF + Excel, built here in the Loan & Advance
  // report's format) attached; a new send replaces the older link ──
  const runSendAuditor = async (again: boolean) => {
    setRefusal(null);
    try {
      setProgress("Building the finalized report (PDF and Excel)…");
      const files = await buildAuditorFiles(batch, company);
      setProgress(`E-mailing the review link to the auditor (${recipients.auditor.join(", ")})…`);
      const sent = await sendAuditor.mutateAsync({ batchId: batch.id, ...files });
      const until = sent?.auditor?.link?.expiresAt;
      toast({
        title: again ? "New review link sent to the auditor" : "Review link sent to the auditor",
        description: `${again ? "The earlier link no longer works. " : ""}The auditor reviews and answers in the Auditor Review Portal${
          until ? `; the link works until ${formatDateTime(until)}` : ""
        }. ${files.pdf.name} and ${files.xlsx.name} are attached.`,
      });
    } catch (err) {
      setRefusal(workflowRefusal(err, "The report could not be sent."));
      // the files of a failed attempt are kept with their status: show them
      void refetchMonth();
    } finally {
      setProgress(null);
    }
  };

  // ── Send Bank File to Accounts: the Payroll bank-file format, the final approved amounts ──
  const runSendAccounts = async (again: boolean) => {
    setRefusal(null);
    try {
      setProgress("Building the bank file…");
      const bank = await buildBatchBankFile(batch);
      setProgress(`Sending the bank file to Accounts (${recipients.accounts.join(", ")})…`);
      await sendAccounts.mutateAsync({ batchId: batch.id, bank });
      toast({
        title: again ? "Bank file sent to Accounts again" : "Bank file sent to Accounts",
        description: again ? bank.name : `${bank.name}. The settlement workflow of ${period} is completed.`,
      });
    } catch (err) {
      setRefusal(workflowRefusal(err, "The bank file could not be sent."));
      void refetchMonth();
    } finally {
      setProgress(null);
    }
  };

  // ── Download a file to check it before sending ──
  const prepare = async (what: "pdf" | "xlsx" | "bank") => {
    setPreparing(what);
    try {
      if (what === "bank") saveFile(await buildBatchBankFile(batch));
      else {
        const files = await buildAuditorFiles(batch, company);
        saveFile(what === "pdf" ? files.pdf : files.xlsx);
      }
    } catch (err) {
      toast({
        title: "Could not build the file",
        description: serverError(err, "Something went wrong while building the file.").text,
        variant: "destructive",
      });
    } finally {
      setPreparing(null);
    }
  };

  const doForward = async (note: string) => {
    try {
      await forward.mutateAsync({ batchId: batch.id, advanceIds: advanceIdsOf(batch), note });
      setDialog(null);
      toast({
        title: `${period} forwarded to the MD`,
        description: `${requestsText(batch.items.length)} wait for the MD now.`,
      });
    } catch (err) {
      if (serverError(err, "").code === "changed") {
        setDialog(null);
        await refetchMonth();
        toast({
          title: "The requests changed",
          description:
            "A request arrived or was withdrawn since the page was loaded. The list is up to date now: look at it again, then forward.",
          variant: "destructive",
        });
        return;
      }
      throw err;
    }
  };

  const doFinalize = async (note: string) => {
    await finalize.mutateAsync({ batchId: batch.id, note });
    setDialog(null);
    const r = finalReview(batch);
    toast({
      title: "Settlement finalized",
      description: `${r.approved} approved (${formatMoney(r.finalApproved)}), ${r.rejected} rejected, locked for the auditor. Next: send the review link to the auditor.`,
    });
  };

  const doProceed = async (note: string) => {
    try {
      await auditorDone.mutateAsync({ batchId: batch.id, note });
    } catch (err) {
      // the auditor marked changes in the portal meanwhile (409 auditor_changes_open): the dialog shows the server's
      // words, and the month is read again so the page shows where the batch stands
      if (serverError(err, "").code === "auditor_changes_open") void refetchMonth();
      throw err;
    }
    setDialog(null);
    toast({
      title: "Auditor review confirmed by hand",
      description:
        "HR's final settlement is applied and the review link is closed. Next: send the bank file to Accounts.",
    });
  };

  // ── HR Rework (MD Changes) -> MD Review, the next round ──
  const doResubmitMd = async (note: string) => {
    try {
      await resubmitMd.mutateAsync({ batchId: batch.id, note });
    } catch (err) {
      if (serverError(err, "").code === "rework_open") void refetchMonth();
      throw err;
    }
    setDialog(null);
    toast({
      title: "Resubmitted to the MD",
      description: `The MD reviews the revised settlement of ${period} now (round ${mdRoundOf(batch) + 1}).`,
    });
  };

  // ── HR Rework (Auditor Changes) -> Send to Auditor -> Auditor Review, in one go: the revised settlement goes back to
  // the auditor with the revised report (PDF + Excel, built here exactly as Send to Auditor does) and a new review link.
  // A refused resubmission keeps the dialog open with the server's words; when only the e-mail fails the batch waits at
  // Send to Auditor, whose own button sends it again ──
  const doResubmitAuditor = async (note: string) => {
    setRefusal(null);
    setProgress("Resubmitting the revised settlement…");
    let revised: SettlementBatch;
    try {
      revised = await resubmitAuditor.mutateAsync({ batchId: batch.id, note });
    } catch (err) {
      setProgress(null);
      if (serverError(err, "").code === "rework_open") void refetchMonth();
      throw err;
    }
    const round = auditorRoundOf(revised);
    try {
      setProgress("Building the revised report (PDF and Excel)…");
      const files = await buildAuditorFiles(revised, company);
      setProgress(`E-mailing a new review link to the auditor (${recipients.auditor.join(", ")})…`);
      const sent = await sendAuditor.mutateAsync({ batchId: batch.id, ...files });
      setDialog(null);
      const until = sent?.auditor?.link?.expiresAt;
      toast({
        title: `Revised settlement sent to the auditor (round ${round})`,
        description: `The auditor reviews it in the Auditor Review Portal${
          until ? `; the link works until ${formatDateTime(until)}` : ""
        }. ${files.pdf.name} and ${files.xlsx.name} are attached. Nothing goes to Accounts until the auditor approves it.`,
      });
    } catch (err) {
      setDialog(null);
      setRefusal(workflowRefusal(err, "The revised report could not be sent."));
      void refetchMonth();
      toast({
        title: "Resubmitted, but not sent to the auditor yet",
        description: "The revised settlement waits at Send to Auditor: send it from there once the problem is fixed.",
        variant: "destructive",
      });
    } finally {
      setProgress(null);
    }
  };

  const doComplete = async (note: string) => {
    await complete.mutateAsync({ batchId: batch.id, note });
    setDialog(null);
    toast({ title: "Settlement workflow completed", description: "Nothing was approved, so no bank file was sent." });
  };

  const stage = batch.stage;
  const review = finalReview(batch);
  const proposals = {
    reduce: batch.items.filter((i) => i.hr?.action === "reduce").length,
    reject: batch.items.filter((i) => i.hr?.action === "reject").length,
    total: batch.items.filter((i) => !!i.hr?.action).length,
  };
  // the MD finalized it with Direct to Auditor, but the e-mail to the auditor did not go: HR sends it from here
  const mdSendFailed = stage === "auditor_send" && batch.finalizedVia === "md";
  const audit = auditorReview(batch);
  // the auditor approved and tried to send the bank file to Accounts, but the e-mail did not go: HR sends it
  const auditorSendFailed =
    stage === "accounts_send" && (batch.history ?? []).some((h) => h.action === "accounts_failed_from_auditor");
  const bankRows = batchBankRows(batch);
  const missing = batchMissingBank(batch);
  const noAuditor = recipients.auditor.length === 0;
  const noAccounts = recipients.accounts.length === 0;
  const rework = stage === "md_changes" || stage === "auditor_changes";
  const answers = rework ? reworkProgress(batch) : { waiting: 0, flagged: 0 };
  const answeredText = `${answers.flagged - answers.waiting} of ${requestsText(answers.flagged)} answered${
    answers.waiting > 0 ? ` · ${answers.waiting} still ${answers.waiting === 1 ? "waits" : "wait"} for you` : ""
  }`;
  const waitingReason = (who: string) =>
    `${requestsText(answers.waiting)} still ${answers.waiting === 1 ? "waits" : "wait"} for your answer: accept ${who}, keep yours or change it first.`;
  const mdRound = mdRoundOf(batch);
  const auditorRound = auditorRoundOf(batch);
  const lastResubmit = [...(batch.history ?? [])].reverse().find((h) => h.action === "md_resubmitted");
  const Icon =
    stage === "completed"
      ? CheckCircle2
      : rework
        ? RotateCcw
        : stage === "md_review"
          ? Hourglass
          : stage === "auditor_review"
            ? Stamp
            : Send;

  const downloads = (kinds: ("pdf" | "xlsx" | "bank")[]) => (
    <span data-view-safe className="contents">
      {kinds.map((k) => (
        <Button
          key={k}
          variant="outline"
          size="sm"
          className="h-9 gap-1.5"
          disabled={preparing !== null || busy}
          onClick={() => void prepare(k)}
          aria-label={
            k === "pdf"
              ? "Download the finalized report (PDF)"
              : k === "xlsx"
                ? "Download the finalized report (Excel)"
                : "Download the bank file"
          }
          data-testid={`auto-download-${k}`}
        >
          {preparing === k ? (
            <Loader2 size={13} className="animate-spin" />
          ) : k === "pdf" ? (
            <FileText size={13} />
          ) : k === "xlsx" ? (
            <FileSpreadsheet size={13} />
          ) : (
            <Download size={13} />
          )}
          {k === "pdf" ? "PDF" : k === "xlsx" ? "Excel" : "Bank file"}
        </Button>
      ))}
    </span>
  );

  const blockedNote = !may && mayNotReason && stage !== "completed" && stage !== "md_review" && (
    <p className="text-xs font-medium text-slate-500" data-testid="auto-view-only">
      {mayNotReason}
    </p>
  );

  return (
    <section
      className={cn(
        "space-y-3 rounded-2xl border p-4 sm:p-5",
        stage === "completed"
          ? "border-emerald-200 bg-emerald-50/50"
          : rework
            ? "border-amber-200 bg-white"
            : "border-indigo-100 bg-white",
      )}
      aria-label="What to do now"
      data-testid="auto-stage-panel"
      data-stage={stage}
    >
      <header className="flex items-start gap-3">
        <span
          className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
            stage === "completed"
              ? "bg-emerald-100 text-emerald-700"
              : rework
                ? "bg-amber-100 text-amber-700"
                : "bg-indigo-50 text-indigo-700",
          )}
          aria-hidden
        >
          <Icon size={18} />
        </span>
        <div className="min-w-0">
          <p className="text-[11.5px] font-semibold text-slate-400">
            {period} · {stage === "completed" ? "Done" : "Current stage"}
          </p>
          <h3 className="text-lg font-black leading-tight text-slate-900" data-testid="auto-stage-title">
            {STAGE_TITLE[stage]}
          </h3>
          {batch.nextAction && <p className="mt-0.5 text-sm text-slate-600">{batch.nextAction}</p>}
        </div>
      </header>

      {/* ── HR Review ── */}
      {stage === "hr_review" && (
        <div className="space-y-3">
          <p className="text-sm text-slate-600">
            {requestsText(batch.items.length)} raised this month {batch.items.length === 1 ? "waits" : "wait"} for your
            review. On the Requests tab, keep each one as asked, propose a smaller amount or propose to reject it with a
            remark (one by one, or several at once), then forward the batch: your proposals reach the MD as their
            starting decisions. A request raised after you forward waits in the next batch.
          </p>
          {proposals.total > 0 && (
            <p className="text-xs font-semibold text-amber-800" data-testid="auto-hr-proposals">
              Your proposals: {proposals.reduce} reduced · {proposals.reject} to reject ·{" "}
              {batch.items.length - proposals.total} kept as asked.
            </p>
          )}
          {blockedNote}
          {may && act.canForward && (
            <Button className="h-10 gap-2" onClick={() => setDialog("forward")} data-testid="auto-forward">
              <ArrowRight size={15} /> Forward to MD
            </Button>
          )}
        </div>
      )}

      {/* ── MD Review ── */}
      {stage === "md_review" && (
        <div className="space-y-2" data-testid="auto-waiting-md">
          {mdRound > 1 && (
            <RoundNote text={`Round ${mdRound} — the MD is reviewing the revised settlement.`} testId="auto-md-round" />
          )}
          <p className="text-sm text-slate-600">
            The MD approves, reduces or rejects each request. With no changes the MD approves the settlement (to you for
            the final settlement, or directly to the auditor); with changes or corrections it comes back to you for
            rework. Nothing to do here until then.
          </p>
          <Facts>
            <Fact label="Forwarded" value={stamp(batch.forwardedAt, batch.forwardedBy)} />
            {mdRound > 1 && lastResubmit && (
              <Fact label="Resubmitted" value={stamp(lastResubmit.at, lastResubmit.by)} />
            )}
            <Fact label="MD's progress" value={`${batch.counts.mdDecided} of ${batch.counts.total} decided so far`} />
          </Facts>
          {mdRound > 1 && lastResubmit?.note ? (
            <p className="rounded-xl bg-slate-50 px-3 py-2 text-[12px] text-slate-700">
              <b>Your note with the revised settlement:</b> {lastResubmit.note}
            </p>
          ) : (
            batch.hrNote && (
              <p className="rounded-xl bg-slate-50 px-3 py-2 text-[12px] text-slate-700">
                <b>Your note to the MD:</b> {batch.hrNote}
              </p>
            )
          )}
        </div>
      )}

      {/* ── HR Rework (MD Changes): answer the MD, then resubmit ── */}
      {stage === "md_changes" && (
        <div className="space-y-3" data-testid="auto-md-changes">
          <Facts>
            <Fact
              label="Returned by the MD"
              value={stamp(batch.flow?.mdReturn?.at ?? null, batch.flow?.mdReturn?.by ?? null)}
            />
            <Fact label="Review round" value={`Round ${mdRound}`} />
            <Fact label="Your answers" value={<span data-testid="auto-rework-progress">{answeredText}</span>} />
          </Facts>
          <ReviewerNote
            title="The MD's instructions"
            note={batch.flow?.mdReturn?.note ?? ""}
            empty="The MD left no note for the whole batch: see the MD's remark on each flagged request."
            testId="auto-md-return-note"
          />
          <p className="text-sm text-slate-600">
            The MD changed amounts, rejected requests or asked for corrections, so the settlement is back with you. On
            the Requests tab, answer every request the MD flagged: accept the MD&apos;s decision, keep your proposal, or
            change it. Then resubmit it: the MD reviews the revised settlement (round {mdRound + 1}) and approves it, to
            you for the final settlement or directly to the auditor.
          </p>
          {blockedNote}
          {may && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                className="h-10 gap-2"
                onClick={() => setDialog("resubmit_md")}
                disabled={!act.canResubmitMd}
                data-testid="auto-resubmit-md"
              >
                <Send size={15} /> Resubmit to the MD
              </Button>
              {onOpenRequests && (
                <Button
                  variant="outline"
                  className="h-10 gap-2"
                  onClick={onOpenRequests}
                  data-view-safe
                  data-testid="auto-open-requests"
                >
                  <ListChecks size={15} /> Answer on the Requests tab
                </Button>
              )}
            </div>
          )}
          {may && !act.canResubmitMd && (
            <p className="text-xs font-medium text-amber-800" data-testid="auto-resubmit-md-blocked">
              {answers.waiting > 0 ? waitingReason("the MD's decision") : "Resubmitting is not open for this batch."}
            </p>
          )}
        </div>
      )}

      {/* ── HR Final Settlement ── */}
      {stage === "hr_final" && (
        <div className="space-y-3">
          <Facts>
            <Fact label="MD confirmed" value={stamp(batch.mdConfirmedAt, batch.mdConfirmedBy)} />
            <Fact
              label="MD's decisions"
              value={`${batch.items.filter((i) => i.md.decision === "approved").length} approved · ${
                batch.items.filter((i) => i.md.decision === "rejected").length
              } rejected · ${formatMoney(batch.amounts.mdApproved)}`}
            />
          </Facts>
          <div
            className="rounded-xl border border-indigo-100 bg-indigo-50 px-3 py-2 text-[13px] text-indigo-900"
            data-testid="auto-md-note"
          >
            <p className="text-[11.5px] font-semibold text-indigo-500">MD&apos;s instructions</p>
            <p>{batch.mdNote || "The MD left no instructions for this batch."}</p>
          </div>
          <p className="text-sm text-slate-600">
            Check each decision (Final decision on a request) and stay within the MD&apos;s: lower an amount, move the
            first deduction month or reject. Finalize locks your final settlement for the auditor; the requests are
            decided (deduction schedules, the employees&apos; notices) once the audit is through.
          </p>
          {review.changed > 0 && (
            <p className="text-xs font-semibold text-orange-700">
              {requestsText(review.changed)} changed from the MD&apos;s decision.
            </p>
          )}
          {blockedNote}
          {may && finalizeBlocked && (
            <p className="text-xs font-medium text-red-700" data-testid="auto-finalize-blocked">
              {finalizeBlocked}
            </p>
          )}
          {may && act.canFinalize && (
            <Button
              className="h-10 gap-2"
              onClick={() => setDialog("finalize")}
              disabled={!!finalizeBlocked}
              data-testid="auto-finalize"
            >
              <ShieldCheck size={15} /> Finalize settlement
            </Button>
          )}
        </div>
      )}

      {/* ── Send to Auditor ── */}
      {stage === "auditor_send" && (
        <div className="space-y-3">
          {mdSendFailed && (
            <p
              className="flex items-start gap-1.5 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"
              role="status"
              data-testid="auto-md-direct-failed"
            >
              <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden />
              The MD finalized this batch and chose Direct to Auditor, but the e-mail to the auditor did not go. The
              settlement is the MD&apos;s decisions; send it to the auditor from here.
            </p>
          )}
          <Facts>
            <Fact label="Finalized" value={<span data-testid="auto-finalized">{finalizedText(batch)}</span>} />
            <Fact
              label="Final settlement"
              value={`${review.approved} approved (${formatMoney(review.finalApproved)}) · ${review.rejected} rejected`}
            />
          </Facts>
          {auditorRound > 1 && (
            <RoundNote
              text={`Send the revised settlement (round ${auditorRound}): your answers to the auditor's changes are in it. Only the auditor's approval of it opens the way to Accounts.`}
              testId="auto-auditor-round"
            />
          )}
          <p className="text-sm text-slate-600" data-testid="auto-send-auditor-explain">
            Send to Auditor e-mails the auditor a secure link to the <b>Auditor Review Portal</b>, with the finalized
            report attached as a PDF and an Excel file. In the portal the auditor checks each request and the
            employees&apos; attendance, may reduce or reject a request with a remark, and approves (sending the bank
            file to Accounts, or leaving it to you) or sends the changes back to you. The link works for the days set in
            Settings and stops working once answered. The stage moves on only when the e-mail is sent.
          </p>
          <div className="rounded-xl bg-slate-50 p-3">
            <p className="mb-1 flex items-center gap-1.5 text-[11.5px] font-semibold text-slate-400">
              <Mail size={12} aria-hidden /> Auditor
            </p>
            {noAuditor ? (
              <NoRecipients who="auditor" testId="auto-no-auditor" />
            ) : (
              <Recipients to={recipients.auditor} cc={recipients.auditorCc} testId="auto-auditor-recipients" />
            )}
          </div>
          <Progress text={progress} testId="auto-progress" />
          <RefusalNote refusal={refusal} testId="auto-send-error" />
          {blockedNote}
          <div className="flex flex-wrap items-center gap-2">
            {may && act.canSendAuditor && (
              <Button
                className="h-10 gap-2"
                onClick={() => void runSendAuditor(false)}
                disabled={busy || noAuditor}
                data-testid="auto-send-auditor"
              >
                {busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}{" "}
                {auditorRound > 1 ? `Send the revised settlement (round ${auditorRound})` : "Send to Auditor"}
              </Button>
            )}
            {downloads(["pdf", "xlsx"])}
          </div>
        </div>
      )}

      {/* ── Auditor Review (the Auditor Review Portal; HR's confirmation by hand is the fallback) ── */}
      {stage === "auditor_review" && (
        <div className="space-y-3">
          {batch.finalizedVia === "md" && (
            <p className="text-xs font-semibold text-violet-800" data-testid="auto-finalized">
              {finalizedText(batch)}
            </p>
          )}
          {auditorRound > 1 && (
            <RoundNote
              text={`Round ${auditorRound} — the auditor is reviewing the revised settlement.`}
              testId="auto-auditor-round"
            />
          )}
          <p className="text-sm text-slate-600">
            The auditor reviews the settlement in the Auditor Review Portal through the link e-mailed to them. When they
            approve, the settlement is applied (and the bank file goes to Accounts if they send it); when they change
            something or ask for corrections, it comes back to you for rework. Resend the link if it expired or got
            lost: a new link replaces the old one.
          </p>
          <LinkStatus link={batch.auditor.link ?? null} />
          <Progress text={progress} testId="auto-progress" />
          <RefusalNote refusal={refusal} testId="auto-send-error" />
          {blockedNote}
          <div className="flex flex-wrap items-center gap-2">
            {may && act.canResendAuditor && (
              <Button
                className="h-10 gap-2"
                onClick={() => void runSendAuditor(true)}
                disabled={busy || noAuditor}
                data-testid="auto-resend-auditor"
              >
                <RotateCcw size={14} /> Resend review link
              </Button>
            )}
            {downloads(["pdf", "xlsx"])}
          </div>
          {may && act.canConfirmAuditor && (
            <div
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-dashed border-slate-300 p-3"
              data-testid="auto-fallback"
            >
              <p className="max-w-xl text-xs text-slate-600">
                <b className="text-slate-800">Auditor confirmed another way?</b> Confirming by hand applies HR&apos;s
                final settlement exactly as finalized (no auditor changes) and closes the review link. It is refused
                while the auditor has changes marked in the portal.
              </p>
              <Button
                variant="ghost"
                size="sm"
                className="h-9 gap-1.5 text-slate-700"
                onClick={() => setDialog("proceed")}
                disabled={busy}
                data-testid="auto-proceed"
              >
                <Hand size={14} /> Confirm auditor review by hand
              </Button>
            </div>
          )}
        </div>
      )}

      {/* ── HR Rework (Auditor Changes): answer the auditor, then resubmit the revised settlement ── */}
      {stage === "auditor_changes" && (
        <div className="space-y-3" data-testid="auto-auditor-changes">
          <Facts>
            <Fact
              label="The auditor answered"
              value={batch.auditor.submittedAt ? formatDateTime(batch.auditor.submittedAt) : "-"}
            />
            <Fact label="Review round" value={`Round ${auditorRound}`} />
            <Fact
              label="Changes"
              value={`${audit.changes} ${audit.changes === 1 ? "request" : "requests"} reduced or rejected · ${audit.remarks} with a remark`}
            />
            <Fact label="Your answers" value={<span data-testid="auto-rework-progress">{answeredText}</span>} />
          </Facts>
          <p className="text-sm text-slate-600">
            The auditor returned the settlement to you for rework. On the Requests tab, answer every request the auditor
            flagged: accept the auditor&apos;s change, keep your settlement, or change the final decision (within the
            MD&apos;s). Then resubmit it: the revised report and a new review link go to the auditor in one step.
          </p>
          <p
            className="flex items-start gap-2 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-[13px] font-medium text-sky-900"
            data-testid="auto-no-accounts-yet"
          >
            <Lock size={14} className="mt-0.5 shrink-0" aria-hidden />
            Nothing goes to Accounts until the auditor approves the revised settlement.
          </p>
          <AuditorChangesReview batch={batch} testId="auto-auditor-changes-review" />
          {noAuditor && <NoRecipients who="auditor" testId="auto-no-auditor" />}
          <Progress text={progress} testId="auto-progress" />
          <RefusalNote refusal={refusal} testId="auto-send-error" />
          {blockedNote}
          {may && finalizeBlocked && (
            <p className="text-xs font-medium text-red-700" data-testid="auto-resubmit-blocked">
              {finalizeBlocked.replace("Finalize decides the advances", "Resubmitting needs the approval right")}
            </p>
          )}
          {may && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                className="h-10 gap-2"
                onClick={() => setDialog("resubmit_auditor")}
                disabled={!act.canResubmitAuditor || busy || noAuditor || !!finalizeBlocked}
                data-testid="auto-resubmit-auditor"
              >
                {busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />} Resubmit to the auditor
              </Button>
              {onOpenRequests && (
                <Button
                  variant="outline"
                  className="h-10 gap-2"
                  onClick={onOpenRequests}
                  data-view-safe
                  data-testid="auto-open-requests"
                >
                  <ListChecks size={15} /> Answer on the Requests tab
                </Button>
              )}
            </div>
          )}
          {may && !act.canResubmitAuditor && (
            <p className="text-xs font-medium text-amber-800" data-testid="auto-resubmit-auditor-blocked">
              {answers.waiting > 0
                ? waitingReason("the auditor's change")
                : "Every request needs a final decision before you resubmit."}
            </p>
          )}
        </div>
      )}

      {/* ── Send Bank File to Accounts ── */}
      {stage === "accounts_send" && (
        <div className="space-y-3">
          <Facts>
            {batch.finalizedVia === "md" && (
              <Fact label="Finalized" value={<span data-testid="auto-finalized">{finalizedText(batch)}</span>} />
            )}
            <Fact
              label="Auditor review"
              value={<span data-testid="auto-audit-outcome">{auditOutcomeText(batch)}</span>}
            />
            {(batch.auditor.note || batch.auditor.submittedNote) && (
              <Fact label="Note" value={batch.auditor.submittedNote || batch.auditor.note} />
            )}
          </Facts>
          {auditorSendFailed && (
            <p
              className="flex items-start gap-1.5 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"
              role="status"
              data-testid="auto-auditor-send-failed"
            >
              <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden />
              The auditor approved and chose to send the bank file to Accounts, but that e-mail did not go. Send it from
              here.
            </p>
          )}
          {act.canCompleteWithoutBankFile ? (
            <p className="text-sm text-slate-600" data-testid="auto-nothing-to-pay">
              No request was approved in this batch, so there is nothing to pay and no bank file to send. Complete the
              workflow without one.
            </p>
          ) : (
            <>
              <p className="text-sm text-slate-600" data-testid="auto-bank-summary">
                The bank file pays <b>{requestsText(bankRows.length)}</b>, <b>{formatMoney(batchBankTotal(batch))}</b>{" "}
                in all: each approved amount as paid (after the auditor&apos;s changes) rounded up to the rupee, in the
                Payroll bank-file format. Only a sent e-mail completes the workflow.
              </p>
              {missing.length > 0 && (
                <div
                  className="space-y-1 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"
                  role="status"
                  data-testid="auto-bank-missing"
                >
                  <p className="flex items-center gap-1.5 font-semibold">
                    <AlertTriangle size={13} className="shrink-0" aria-hidden />
                    {missing.length === 1
                      ? "1 employee has no bank account or IFSC"
                      : `${missing.length} employees have no bank account or IFSC`}
                    . Their rows are in the file with the details blank.
                  </p>
                  <ul className="list-disc pl-5">
                    {missing.map((a) => (
                      <li key={a.id}>
                        {a.employeeName} ({a.employeeCode}):{" "}
                        {[!(a.bankAccount ?? "").trim() && "no account number", !(a.bankIfsc ?? "").trim() && "no IFSC"]
                          .filter(Boolean)
                          .join(", ")}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="rounded-xl bg-slate-50 p-3">
                <p className="mb-1 flex items-center gap-1.5 text-[11.5px] font-semibold text-slate-400">
                  <Landmark size={12} aria-hidden /> Accounts
                </p>
                {noAccounts ? (
                  <NoRecipients who="Accounts" testId="auto-no-accounts" />
                ) : (
                  <Recipients to={recipients.accounts} cc={recipients.accountsCc} testId="auto-accounts-recipients" />
                )}
              </div>
            </>
          )}
          <Progress text={progress} testId="auto-progress" />
          <RefusalNote refusal={refusal} testId="auto-send-error" />
          {blockedNote}
          <div className="flex flex-wrap items-center gap-2">
            {may && act.canSendAccounts && (
              <Button
                className="h-10 gap-2"
                onClick={() => void runSendAccounts(false)}
                disabled={busy || noAccounts}
                data-testid="auto-send-accounts"
              >
                {busy ? <Loader2 size={15} className="animate-spin" /> : <Landmark size={15} />} Send Bank File to
                Accounts
              </Button>
            )}
            {may && act.canCompleteWithoutBankFile && (
              <Button className="h-10 gap-2" onClick={() => setDialog("complete")} data-testid="auto-complete">
                <CheckCircle2 size={15} /> Complete without bank file
              </Button>
            )}
            {bankRows.length > 0 && downloads(["bank"])}
          </div>
        </div>
      )}

      {/* ── Completed ── */}
      {stage === "completed" && (
        <div className="space-y-3" data-testid="auto-completed">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Summary label="Requests" value={String(batch.items.length)} />
            <Summary label="Approved" value={`${audit.approved} · ${formatMoney(audit.payable)}`} />
            <Summary label="Rejected" value={String(audit.rejected)} />
            <Summary label="Completed" value={batch.completedAt ? formatDateTime(batch.completedAt) : "-"} />
          </div>
          <Facts>
            <Fact label="Finalized" value={<span data-testid="auto-finalized">{finalizedText(batch)}</span>} />
            <Fact label="Sent to the auditor" value={stamp(batch.auditor.sentAt, batch.auditor.sentBy)} />
            <Fact label="Auditor review" value={auditOutcomeText(batch)} />
            <Fact
              label="Bank file to Accounts"
              value={
                <span data-testid="auto-accounts-sent-via">
                  {batch.accounts.sentAt
                    ? `${stamp(batch.accounts.sentAt, null)} · sent by ${
                        batch.accounts.sentVia === "auditor"
                          ? "the auditor (from the review portal)"
                          : batch.accounts.sentBy
                            ? `HR (${batch.accounts.sentBy})`
                            : "HR"
                      }`
                    : "No bank file"}
                </span>
              }
            />
          </Facts>
          <Progress text={progress} testId="auto-progress" />
          <RefusalNote refusal={refusal} testId="auto-send-error" />
          <div className="flex flex-wrap items-center gap-2">
            {may && act.canResendAccounts && (
              <Button
                variant="outline"
                className="h-10 gap-2"
                onClick={() => void runSendAccounts(true)}
                disabled={busy || noAccounts}
                data-testid="auto-resend-accounts"
              >
                <RotateCcw size={14} /> Resend to Accounts
              </Button>
            )}
            {downloads(bankRows.length > 0 ? ["pdf", "xlsx", "bank"] : ["pdf", "xlsx"])}
          </div>
        </div>
      )}

      <NoteActionDialog
        open={dialog === "forward"}
        title={`Forward ${period} to the MD?`}
        description={
          <>
            <p>
              <b className="text-gray-900">{requestsText(batch.items.length)}</b>,{" "}
              <b className="text-gray-900">{formatMoney(batch.amounts.requested)}</b> asked for in all
              {roundedTotalOf(batch) != null && roundedTotalOf(batch) !== batch.amounts.requested && (
                <span data-testid="forward-rounded">
                  {" "}
                  (rounded total <b className="text-gray-900">{formatMoney(roundedTotalOf(batch))}</b>)
                </span>
              )}
              {batch.counts.critical + batch.counts.warning > 0
                ? `; leave flags: ${batch.counts.critical} critical, ${batch.counts.warning} warning`
                : ""}
              .
            </p>
            {proposals.total > 0 && (
              <p data-testid="forward-proposals">
                Your proposals go with it: {proposals.reduce} reduced, {proposals.reject} to reject; the MD sees them as
                the starting decisions.
              </p>
            )}
            <p>
              The MD then approves, reduces or rejects each one. The requests can no longer be withdrawn or deleted, and
              a request raised from now on waits in the next batch.
            </p>
          </>
        }
        noteLabel="Note to the MD (optional)"
        notePlaceholder="e.g. Two requests are above the earned limit"
        confirmLabel="Forward to MD"
        busyLabel="Forwarding…"
        onConfirm={doForward}
        onCancel={() => setDialog(null)}
        testId="forward-dialog"
      />

      <NoteActionDialog
        open={dialog === "finalize"}
        wide
        title={`Finalize the settlement of ${period}?`}
        description={
          <p>
            Your final settlement below is locked for the auditor and can no longer be changed. The requests are decided
            (the deduction schedules, the decision history and the employees&apos; WhatsApp and app notices) once the
            audit is through: when the auditor approves, when you accept the auditor&apos;s changes, or when you confirm
            the review by hand.
          </p>
        }
        confirmLabel="Finalize settlement"
        busyLabel="Finalizing…"
        onConfirm={doFinalize}
        onCancel={() => setDialog(null)}
        testId="finalize-dialog"
        confirmDisabled={review.undecided > 0 || !!finalizeBlocked}
      >
        <FinalizeReview batch={batch} />
      </NoteActionDialog>

      <NoteActionDialog
        open={dialog === "proceed"}
        title="Confirm the auditor's review by hand?"
        description={
          <>
            <p>
              Use this only when the auditor confirmed {period} another way (by phone, on paper). HR&apos;s final
              settlement is applied exactly as finalized, with no auditor changes: the deduction schedules, the decision
              history and the employees&apos; notices.
            </p>
            <p>The review link stops working, and the next step is the bank file for Accounts.</p>
          </>
        }
        notePlaceholder="e.g. Auditor confirmed by phone, no changes"
        confirmLabel="Confirm review by hand"
        busyLabel="Saving…"
        onConfirm={doProceed}
        onCancel={() => setDialog(null)}
        testId="proceed-dialog"
      />

      <NoteActionDialog
        open={dialog === "resubmit_md"}
        title={`Resubmit the revised settlement of ${period} to the MD?`}
        description={
          <>
            <p>
              Your answers to the MD go with it ({answeredText}). The MD reviews the revised settlement in round{" "}
              {mdRound + 1}: a request whose proposal is now the MD&apos;s own decision keeps it; one you kept or
              changed waits for the MD&apos;s decision again.
            </p>
            <p>With no further changes the MD approves it; with changes it comes back to you once more.</p>
          </>
        }
        noteLabel="Note to the MD (optional)"
        notePlaceholder="e.g. Accepted your cuts; kept Ravi's amount, see the remark"
        confirmLabel="Resubmit to the MD"
        busyLabel="Resubmitting…"
        onConfirm={doResubmitMd}
        onCancel={() => setDialog(null)}
        testId="resubmit-md-dialog"
      />

      <NoteActionDialog
        open={dialog === "resubmit_auditor"}
        title={`Resubmit the revised settlement of ${period} to the auditor?`}
        description={
          <>
            <p>
              In one step: your answers are kept as the revised final settlement (round {auditorRound + 1}), the revised
              report is built as a PDF and an Excel file, and the auditor gets a new review link with it (the old link
              stops working). The auditor&apos;s changes of this round stay in each request&apos;s history.
            </p>
            <p>Nothing goes to Accounts until the auditor approves the revised settlement.</p>
          </>
        }
        noteLabel="Note to the auditor (optional)"
        notePlaceholder="e.g. Accepted both cuts; kept Asha's amount, see the remark"
        confirmLabel="Resubmit and send"
        busyLabel="Working…"
        onConfirm={doResubmitAuditor}
        onCancel={() => setDialog(null)}
        testId="resubmit-auditor-dialog"
      >
        <Progress text={dialog === "resubmit_auditor" ? progress : null} testId="resubmit-auditor-progress" />
      </NoteActionDialog>

      <NoteActionDialog
        open={dialog === "complete"}
        title={`Complete ${period} without a bank file?`}
        description={<p>Every request of this batch was rejected, so there is nothing to pay.</p>}
        confirmLabel="Complete without bank file"
        busyLabel="Completing…"
        onConfirm={doComplete}
        onCancel={() => setDialog(null)}
        testId="complete-dialog"
      />
    </section>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-white px-3 py-2 ring-1 ring-emerald-100">
      <p className="text-[11px] font-semibold text-slate-400">{label}</p>
      <p className="text-sm font-bold text-slate-900">{value}</p>
    </div>
  );
}
