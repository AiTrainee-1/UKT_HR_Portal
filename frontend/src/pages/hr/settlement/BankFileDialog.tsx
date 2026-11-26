import { useState } from "react";
import { AlertTriangle, Landmark, Loader2 } from "lucide-react";
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
  bankFileLines,
  bankFileName,
  bankFileSheet,
  bankFileTotal,
  countOf,
  missingBankDetails,
  periodLabel,
  tabLabel,
  type PageState,
  type SettlementRow,
} from "./logic";
import { formatMoney } from "./shared";

/**
 * Before the bank file downloads (owner 2026-11-26): how many approved advances it pays, the total, and who has no bank
 * account or IFSC (still allowed, flagged, so HR can fix them in the bank's portal). The file is the Payroll's bank file
 * format (lib/bankFile.ts), one row per advance, paying the APPROVED amount.
 */
export default function BankFileDialog({
  rows,
  state,
  open,
  onClose,
}: {
  /** The approved (active or completed) advances to pay: logic.bankFileRows. */
  rows: SettlementRow[];
  state: PageState;
  open: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const missing = missingBankDetails(rows);
  const total = bankFileTotal(rows);
  const name = bankFileName(state);

  const download = async () => {
    setBusy(true);
    try {
      const { downloadBankFile } = await import("@/lib/bankFile");
      await downloadBankFile(bankFileLines(rows), bankFileSheet(state), name);
      toast({ title: "Bank file downloaded", description: `${name}: ${countOf(rows.length, state.tab)}` });
      onClose();
    } catch (err) {
      toast({
        title: "Could not build the bank file",
        description: err instanceof Error ? err.message : "Something went wrong while building the file.",
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <AlertDialogContent data-view-safe data-testid="bank-file-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Landmark size={18} /> Bank file: {tabLabel(state.tab)}, {periodLabel(state.period)}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p data-testid="bank-file-summary">
                <b className="text-gray-900">{countOf(rows.length, state.tab)}</b> approved (active or completed),{" "}
                <b className="text-gray-900">{formatMoney(total)}</b> in all: each one's approved amount.
              </p>
              <p className="text-xs">
                Same format as the Payroll bank file. Waiting and rejected requests are never in it. File: {name}
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        {missing.length > 0 && (
          <div
            className="space-y-1 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"
            role="status"
            data-testid="bank-file-missing"
          >
            <p className="flex items-center gap-1.5 font-semibold">
              <AlertTriangle size={13} className="shrink-0" />
              {missing.length === 1
                ? "1 employee has no bank account or IFSC"
                : `${missing.length} employees have no bank account or IFSC`}
              . Their rows are in the file with the details blank.
            </p>
            <ul className="max-h-32 list-disc overflow-y-auto pl-5">
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

        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy} data-testid="bank-file-cancel">
            Cancel
          </AlertDialogCancel>
          <Button type="button" onClick={download} disabled={busy} className="gap-2" data-testid="bank-file-confirm">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Landmark size={14} />} Download bank file
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
