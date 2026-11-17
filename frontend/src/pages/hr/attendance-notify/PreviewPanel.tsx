import { AlertTriangle, Download, Eye, FileText, Loader2, Paperclip, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { NotifyChatReport, NotifyMessage, NotifyPreview } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { PersonAvatar } from "../device-control/parts";
import ReportCard from "./ReportCard";
import {
  CHANNEL_LABEL,
  dateLabel,
  orderedCategories,
  rangeLabel,
  recipientSummary,
  whatsappSegments,
  type NotifyDraft,
} from "./logic";
import { CategoryChip, ChannelBadge } from "./parts";

/** A WhatsApp text as the phone draws it (*bold*, _italic_). */
function WhatsAppText({ text }: { text: string }) {
  return (
    <>
      {whatsappSegments(text).map((s, i) =>
        s.bold ? <b key={i}>{s.text}</b> : s.italic ? <i key={i}>{s.text}</i> : <span key={i}>{s.text}</span>,
      )}
    </>
  );
}

function DocumentBubble({ m }: { m: NotifyMessage }) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl bg-white px-3 py-2.5 shadow-sm">
      <span className="rounded-lg bg-red-50 p-2 text-red-600">
        <FileText size={18} />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold text-slate-900">{m.filename ?? "report.pdf"}</span>
        <span className="block text-[11px] text-slate-500">PDF document{m.text ? ` · ${m.text}` : ""}</span>
      </span>
    </div>
  );
}

function WhatsAppPreview({ messages }: { messages: NotifyMessage[] }) {
  return (
    <div className="space-y-2 rounded-2xl bg-emerald-50 p-3" data-testid="an-preview-whatsapp">
      {messages.map((m, i) =>
        m.kind === "document" ? (
          <div key={i} className="max-w-md">
            <DocumentBubble m={m} />
          </div>
        ) : (
          <div
            key={i}
            className="max-w-xl whitespace-pre-wrap break-words rounded-xl rounded-tl-sm bg-white px-3.5 py-2.5 text-[13px] leading-relaxed text-slate-900 shadow-sm"
            data-testid="an-preview-bubble"
          >
            <WhatsAppText text={m.text} />
          </div>
        ),
      )}
    </div>
  );
}

function EmailPreview({ preview, draft }: { preview: NotifyPreview; draft: NotifyDraft }) {
  const r = draft.recipients;
  const text = preview.messages.find((m) => m.kind === "text")?.text ?? "";
  const attachments = preview.messages.filter((m) => m.kind === "document");
  const html = draft.emailFormat === "html" ? preview.html : null;
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white" data-testid="an-preview-email">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-b border-slate-100 bg-slate-50 px-4 py-3 text-xs">
        <dt className="font-semibold text-slate-500">To</dt>
        <dd className="text-slate-800">{r.to.join(", ") || (r.listIds.length ? "the saved list(s)" : "—")}</dd>
        {r.cc.length > 0 && (
          <>
            <dt className="font-semibold text-slate-500">CC</dt>
            <dd className="text-slate-800">{r.cc.join(", ")}</dd>
          </>
        )}
        {r.bcc.length > 0 && (
          <>
            <dt className="font-semibold text-slate-500">BCC</dt>
            <dd className="text-slate-800">{r.bcc.join(", ")}</dd>
          </>
        )}
        <dt className="font-semibold text-slate-500">Subject</dt>
        <dd className="font-semibold text-slate-900" data-testid="an-preview-subject">
          {preview.subject || draft.subject || "Attendance report"}
        </dd>
      </dl>
      {html ? (
        <iframe
          title="The email as it will be sent"
          srcDoc={html}
          sandbox=""
          className="h-[28rem] w-full bg-white"
          data-testid="an-preview-email-html"
        />
      ) : (
        <pre
          className="max-h-[28rem] overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-sans text-[13px] leading-relaxed text-slate-800"
          data-testid="an-preview-email-text"
        >
          {text || "The email body is empty."}
        </pre>
      )}
      {(attachments.length > 0 || draft.attachPdf) && (
        <div className="flex flex-wrap gap-2 border-t border-slate-100 px-4 py-2.5">
          {(attachments.length ? attachments : [{ kind: "document" as const, text: "", filename: null }]).map(
            (m, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-slate-700"
              >
                <Paperclip size={12} /> {m.filename ?? "The report as a PDF"}
              </span>
            ),
          )}
        </div>
      )}
    </div>
  );
}

function ChatPreview({ preview, draft }: { preview: NotifyPreview; draft: NotifyDraft }) {
  const first = preview.dates[0] ?? null;
  const last = preview.dates[preview.dates.length - 1] ?? null;
  const report: NotifyChatReport = {
    title: draft.name.trim() || "Attendance report",
    date: first ?? "",
    dateLabel: rangeLabel(first, last),
    counts: preview.counts,
    categories: orderedCategories(draft.categories),
    rows: draft.content === "summary" ? [] : preview.rows,
    content: draft.content,
    includePhotos: draft.includePhotos,
    employees: preview.employees,
    total: preview.total,
    asOf: null,
    truncated: preview.truncated,
  };
  const text = preview.messages
    .filter((m) => m.kind === "text")
    .map((m) => m.text)
    .join("\n\n");
  return (
    <div className="space-y-2 rounded-2xl bg-indigo-50 p-3" data-testid="an-preview-chat">
      <ReportCard report={report} className="max-w-xl" />
      {text && (
        <details className="max-w-xl text-xs">
          <summary className="cursor-pointer font-semibold text-indigo-700">The text the mobile app shows</summary>
          <p className="mt-1.5 whitespace-pre-wrap rounded-lg bg-white px-3 py-2 text-slate-700">{text}</p>
        </details>
      )}
    </div>
  );
}

function RowsTable({ preview }: { preview: NotifyPreview }) {
  if (preview.rows.length === 0) return null;
  const many = new Set(preview.rows.map((r) => r.date)).size > 1;
  return (
    <div className="space-y-1.5" data-testid="an-preview-rows">
      <p className="text-xs font-semibold text-slate-700">
        Employees in the report ({preview.employees.toLocaleString("en-IN")})
      </p>
      <div className="max-h-80 overflow-auto rounded-xl border border-slate-200">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2 font-semibold">Employee</th>
              <th className="px-3 py-2 font-semibold">Department</th>
              <th className="px-3 py-2 font-semibold">Category</th>
              <th className="px-3 py-2 font-semibold">Detail</th>
              {many && <th className="px-3 py-2 font-semibold">Date</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {preview.rows.map((r, i) => (
              <tr key={`${r.employeeId ?? r.code}-${r.date}-${r.category}-${i}`}>
                <td className="px-3 py-2">
                  <span className="flex items-center gap-2">
                    <PersonAvatar name={r.name || r.code} photoUrl={r.photoUrl} size={26} />
                    <span className="min-w-0">
                      <span className="block font-semibold text-slate-900">{r.name}</span>
                      <span className="block font-mono text-[10px] text-slate-500">
                        {r.code}
                        {r.employmentType ? ` · ${r.employmentType}` : ""}
                      </span>
                    </span>
                  </span>
                </td>
                <td className="px-3 py-2 text-slate-600">{r.department || "—"}</td>
                <td className="px-3 py-2">
                  <CategoryChip category={r.category} />
                </td>
                <td className="px-3 py-2 text-slate-700">{r.detail || "—"}</td>
                {many && <td className="whitespace-nowrap px-3 py-2 text-slate-500">{dateLabel(r.date)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {preview.truncated && (
        <p className="text-[11px] text-slate-500">
          Only the first {preview.rows.length} lines are shown here; the report itself lists everyone.
        </p>
      )}
    </div>
  );
}

/**
 * What the draft would send if it ran now (nothing is sent): the day(s) and counts, the message(s) exactly as they go out
 * (WhatsApp bubbles, the email in a closed frame, the chat card), the server's warnings, the employees, and the PDF.
 */
export default function PreviewPanel({
  draft,
  preview,
  loading,
  error,
  stale,
  onRefresh,
  onDownload,
  downloading,
}: {
  draft: NotifyDraft;
  preview: NotifyPreview | undefined;
  loading: boolean;
  error: string | null;
  /** The form changed after this preview was made. */
  stale: boolean;
  onRefresh: () => void;
  onDownload: () => void;
  downloading: boolean;
}) {
  const cats = orderedCategories(draft.categories);
  return (
    <div className="space-y-4" data-testid="an-preview">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
          <Eye size={15} /> If it ran now · <ChannelBadge channel={draft.channel} />
          <span className="text-xs font-normal text-slate-500">
            to {recipientSummary(draft.channel, draft.recipients).toLowerCase()}
          </span>
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-1.5"
            onClick={onRefresh}
            disabled={loading}
            data-view-safe
            data-testid="an-preview-refresh"
          >
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> Refresh preview
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-1.5"
            onClick={onDownload}
            disabled={downloading}
            data-view-safe
            data-testid="an-preview-pdf"
          >
            {downloading ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} Download PDF
          </Button>
        </div>
      </div>

      {error ? (
        <p
          className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800"
          role="status"
          data-testid="an-preview-error"
        >
          {error}
        </p>
      ) : !preview ? (
        <div className="space-y-2" aria-busy>
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : (
        <div className={cn("space-y-4 transition-opacity", (loading || stale) && "opacity-60")}>
          {stale && !loading && (
            <p className="text-xs font-medium text-amber-700">
              The form changed: refresh the preview to see the new version.
            </p>
          )}
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3" data-testid="an-preview-summary">
            <p className="text-xs text-slate-600">
              Report for{" "}
              <b className="text-slate-900">{rangeLabel(preview.dates[0], preview.dates[preview.dates.length - 1])}</b>{" "}
              · <b className="text-slate-900">{preview.employees.toLocaleString("en-IN")}</b> of{" "}
              {preview.total.toLocaleString("en-IN")} employees
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {cats.map((c) => (
                <CategoryChip key={c} category={c} count={preview.counts[c] ?? 0} />
              ))}
            </div>
          </div>

          {preview.warnings.length > 0 && (
            <ul className="space-y-1" data-testid="an-preview-warnings">
              {preview.warnings.map((w) => (
                <li key={w} className="flex items-start gap-1.5 text-xs text-amber-800">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0" /> {w}
                </li>
              ))}
            </ul>
          )}

          {preview.messages.length === 0 && !preview.html ? (
            <p
              className="rounded-xl bg-slate-50 px-3 py-6 text-center text-sm text-slate-500"
              data-testid="an-preview-nothing"
            >
              {draft.skipWhenEmpty
                ? "Nobody is in the chosen categories, so nothing would be sent (Skip when empty is on)."
                : "Nothing would be sent."}
            </p>
          ) : draft.channel === "whatsapp" ? (
            <WhatsAppPreview messages={preview.messages} />
          ) : draft.channel === "email" ? (
            <EmailPreview preview={preview} draft={draft} />
          ) : (
            <ChatPreview preview={preview} draft={draft} />
          )}

          {draft.channel !== "chat" && <RowsTable preview={preview} />}
          <p className="text-[11px] text-slate-400">
            Nothing has been sent. {CHANNEL_LABEL[draft.channel]} sends this at the times on the Schedule step.
          </p>
        </div>
      )}
    </div>
  );
}
