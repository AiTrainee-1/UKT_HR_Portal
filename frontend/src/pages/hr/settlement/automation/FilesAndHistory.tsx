import { useState } from "react";
import { Download, FileSpreadsheet, FileText, History, Landmark, Loader2, Paperclip } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  downloadSettlementBatchFile,
  type SettlementBatch,
  type SettlementBatchFile,
} from "@/lib/api-client/custom-hooks/settlement-automation";
import { EMAIL_STATUS_TONE } from "@/lib/statusTones";
import { serverError } from "../logic";
import { Chip } from "../parts";
import { formatDateTime } from "../shared";
import { historyDetail, historyLabel, historyNewestFirst, sizeText } from "./logic";

const FILE_ICON: Record<SettlementBatchFile["kind"], typeof FileText> = {
  report_pdf: FileText,
  report_xlsx: FileSpreadsheet,
  bank_file: Landmark,
};

const EMAIL_WORD: Record<string, string> = { sent: "Sent", failed: "Not sent", blocked: "Held back" };

/** The files the workflow sent (or tried to: a failed e-mail keeps its files, marked), downloadable, newest first: the
 *  page's "Files sent" tab (owner 2026-11-27: every section is its own top tab, nothing stacked or nested). */
export function FilesSent({ batch }: { batch: SettlementBatch }) {
  const { toast } = useToast();
  const [loading, setLoading] = useState<number | null>(null);
  const files = [...batch.files].sort((a, b) => ((a.createdAt ?? "") < (b.createdAt ?? "") ? 1 : -1));

  const download = async (file: SettlementBatchFile) => {
    setLoading(file.id);
    try {
      await downloadSettlementBatchFile(file);
    } catch (err) {
      toast({
        title: "Could not download the file",
        description: serverError(err, "Try again.").text,
        variant: "destructive",
      });
    } finally {
      setLoading(null);
    }
  };

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4" aria-label="Files sent" data-view-safe>
      <h3 className="mb-2 flex items-center gap-1.5 text-sm font-bold text-slate-900">
        <Paperclip size={14} aria-hidden /> Files sent
      </h3>
      {files.length === 0 ? (
        <p className="text-[13px] text-slate-500" data-testid="auto-files-empty">
          Nothing sent yet. The finalized report and the bank file appear here once they are e-mailed.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100" data-testid="auto-files">
          {files.map((f) => {
            const Icon = FILE_ICON[f.kind] ?? FileText;
            const status = f.emailStatus ?? "";
            return (
              <li key={f.id} className="flex items-center gap-3 py-2" data-testid={`auto-file-${f.id}`}>
                <Icon size={16} className="shrink-0 text-slate-400" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-semibold text-slate-800" title={f.filename}>
                    {f.filename}
                  </p>
                  <p className="text-[11px] text-slate-500">
                    {f.kindLabel} · {sizeText(f.size)} · {formatDateTime(f.createdAt)}
                    {f.createdBy ? ` · ${f.createdBy}` : ""}
                  </p>
                  {f.sentTo.length > 0 && (
                    <p className="truncate text-[11px] text-slate-400" title={f.sentTo.join(", ")}>
                      To {f.sentTo.join(", ")}
                    </p>
                  )}
                </div>
                {status && <Chip tone={EMAIL_STATUS_TONE[status] ?? "neutral"}>{EMAIL_WORD[status] ?? status}</Chip>}
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => void download(f)}
                  disabled={loading === f.id}
                  aria-label={`Download ${f.filename}`}
                  data-testid={`auto-file-download-${f.id}`}
                >
                  {loading === f.id ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** The batch's history, newest first: the page's "History" tab. */
export function BatchHistory({ batch }: { batch: SettlementBatch }) {
  const history = historyNewestFirst(batch.history ?? []);
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4" aria-label="History" data-view-safe>
      <h3 className="mb-2 flex items-center gap-1.5 text-sm font-bold text-slate-900">
        <History size={14} aria-hidden /> History
      </h3>
      {history.length === 0 ? (
        <p className="text-[13px] text-slate-500" data-testid="auto-history-empty">
          Nothing has happened to this batch yet: it is still at HR Review.
        </p>
      ) : (
        <ol className="space-y-3 border-l-2 border-slate-100 pl-4" data-testid="auto-history">
          {history.map((h, i) => (
            <li key={`${h.at}-${h.action}-${i}`} className="relative">
              <span
                aria-hidden
                className="absolute -left-[1.4rem] top-1 h-2.5 w-2.5 rounded-full border-2 border-white bg-indigo-400"
              />
              <p className="text-[13px] font-semibold text-slate-800">{historyLabel(h)}</p>
              <p className="text-[11px] text-slate-500">
                {formatDateTime(h.at)}
                {h.by ? ` · ${h.by}` : ""}
              </p>
              {historyDetail(h) && <p className="text-[11px] text-slate-600">{historyDetail(h)}</p>}
              {h.note && <p className="mt-0.5 text-[12px] italic text-slate-700">&ldquo;{h.note}&rdquo;</p>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
