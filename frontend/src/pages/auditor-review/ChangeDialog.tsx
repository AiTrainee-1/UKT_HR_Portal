import { useEffect, useState } from "react";
import { Ban, Loader2, MessageSquarePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { REMARK_MAX } from "@/pages/hr/settlement/logic";
import { formatMoney } from "@/pages/hr/settlement/shared";
import type { PortalChangeInput, PortalItem } from "./api";
import { changeBody, changeProblems, refusalText, type ChangeMode } from "./logic";
import { HEADING_FONT } from "./parts";

const TITLE: Record<ChangeMode, string> = {
  reject: "Reject this request",
  remark: "Remark on this request",
};

const MODE_ICON = {
  reject: { icon: Ban, className: "bg-rose-50 text-rose-700" },
  remark: { icon: MessageSquarePlus, className: "bg-[#006496]/10 text-[#006496]" },
} as const;

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium text-slate-500">{label}</dt>
      <dd className="truncate text-[14px] font-semibold tabular-nums text-slate-900">{value}</dd>
    </div>
  );
}

/**
 * One answer by the auditor on one request: a rejection (with the reason), or a remark alone - how the auditor asks HR
 * for a change (owner 2026-11-27: the auditor does not reduce amounts; HR does it in the rework). Checked here as the
 * server checks it; the dialog stays open while it saves and shows the server's own words when it is refused.
 */
export default function ChangeDialog({
  item,
  mode,
  term,
  onSave,
  onClose,
}: {
  item: PortalItem | null;
  mode: ChangeMode;
  /** A Term Loan batch: the facts and the preview speak of the eligible limit and the monthly EMI. */
  term: boolean;
  onSave: (item: PortalItem, body: PortalChangeInput) => Promise<void>;
  onClose: () => void;
}) {
  const [remark, setRemark] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);

  useEffect(() => {
    if (!item) return;
    setRemark(item.auditor.remark ?? "");
    setTried(false);
    setRefused(null);
  }, [item, mode]);

  const problems = item ? changeProblems(item, mode, "", remark) : {};
  const shown = tried ? problems : {};
  const save = async () => {
    if (!item) return;
    setTried(true);
    setRefused(null);
    if (Object.values(problems).some(Boolean)) return;
    setBusy(true);
    try {
      await onSave(item, changeBody(item, mode, "", remark));
    } catch (err) {
      setRefused(refusalText(err, "The change could not be saved.").text);
    } finally {
      setBusy(false);
    }
  };

  const a = item?.advance;
  const approved = item?.final.decision === "approved";
  const limit = term ? (a?.termLimit ?? null) : (a?.earnings?.limit ?? null);
  const { icon: Icon, className: iconTone } = MODE_ICON[mode];
  return (
    <Dialog open={!!item} onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        className="max-h-[92vh] max-w-md gap-0 overflow-y-auto bg-white p-0"
        data-testid="portal-change-dialog"
        data-mode={mode}
      >
        <DialogHeader className="space-y-0 border-b border-slate-100 px-5 pb-4 pr-12 pt-5 text-left">
          <div className="flex items-start gap-3">
            <span className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl", iconTone)}>
              <Icon size={18} aria-hidden />
            </span>
            <div className="min-w-0">
              <DialogTitle
                className="text-[17px] font-bold text-slate-900"
                style={{ fontFamily: HEADING_FONT }}
                data-testid="portal-change-title"
              >
                {TITLE[mode]}
              </DialogTitle>
              <DialogDescription className="mt-0.5 text-[13px] text-slate-500">
                {a ? `${a.employeeName} · ${a.employeeCode}` : ""}
                {a?.employeeDepartment ? ` · ${a.employeeDepartment}` : ""}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <div className="space-y-4 px-5 py-4">
          {item && (
            <dl className="grid grid-cols-3 gap-3 rounded-xl bg-slate-50 px-3.5 py-3" data-testid="portal-change-facts">
              <Fact label="Requested" value={formatMoney(item.requestedAmount)} />
              <Fact label="HR approved" value={approved ? formatMoney(item.final.amount) : "Rejected"} />
              <Fact label={term ? "Eligible limit" : "Limit"} value={limit != null ? formatMoney(limit) : "—"} />
            </dl>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="portal-change-remark" className="text-[13px] font-semibold text-slate-800">
              {mode === "reject" ? "Reason for rejecting" : "Remark"}
              {mode !== "remark" && <span className="text-rose-600"> *</span>}
            </Label>
            <Textarea
              id="portal-change-remark"
              rows={3}
              maxLength={REMARK_MAX}
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
              placeholder={
                mode === "reject"
                  ? "e.g. Too many absent days this month"
                  : "e.g. Please lower this to the days worked (leave empty to remove the remark)"
              }
              aria-invalid={!!shown.remark}
              aria-describedby={shown.remark ? "portal-change-remark-error" : "portal-change-remark-hint"}
              className={cn("resize-y text-[14px]", shown.remark && "border-rose-400")}
              data-testid="portal-change-remark"
            />
            {shown.remark ? (
              <p id="portal-change-remark-error" role="alert" className="text-xs font-medium text-rose-700">
                {shown.remark}
              </p>
            ) : (
              <p id="portal-change-remark-hint" className="text-[11.5px] text-slate-500">
                {mode === "remark"
                  ? "A remark does not change the amount: to have it changed, return the settlement to HR for rework."
                  : "HR sees this reason with your rejection."}
              </p>
            )}
          </div>
          {refused && (
            <p
              className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs font-medium text-rose-800"
              role="alert"
              data-testid="portal-change-error"
            >
              {refused}
            </p>
          )}
        </div>
        <DialogFooter className="gap-2 border-t border-slate-100 bg-slate-50/60 px-5 py-3.5 sm:gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => void save()}
            disabled={busy}
            className={cn(
              "gap-1.5",
              mode === "reject" ? "bg-rose-600 hover:bg-rose-700" : "bg-[#006496] hover:bg-[#00547e]",
            )}
            data-testid="portal-change-save"
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            {mode === "reject" ? "Reject request" : "Save remark"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
