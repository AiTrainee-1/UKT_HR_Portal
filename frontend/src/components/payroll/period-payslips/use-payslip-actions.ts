import { useState } from "react";
import { errorText } from "@/components/payroll/panels/payslips/payslips-logic";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import {
  downloadPayslipsPdf,
  payslipsPdfUrl,
  previewDocumentPdf,
  useEmailSalarySlip,
  useWhatsAppSalarySlip,
  whatsappSendToast,
  type PayrollScope,
  type PayslipLayout,
  type PayslipRow,
} from "@/lib/api-client/custom-hooks";
import { payslipsFileName } from "./logic";

export type RowAction = "preview" | "download" | "email" | "whatsapp";
export type BulkDownload = "picked" | "all";

/** Why Email / WhatsApp cannot be used on a row (no saved salary slip behind the payroll), or null when they can. */
export const noSlipReason = (row: Pick<PayslipRow, "slipId">): string | null =>
  row.slipId ? null : "No payslip was saved for this payroll: generate the payroll again to make one.";

/**
 * What can be done with the month's / period's payslips: one payslip's PDF (preview in a new tab or download), its email
 * and its WhatsApp (the same /api/salary-slips/<slipId>/... endpoints the old panel used), and one PDF of many. `busy` is
 * the row action running (its button spins, the others of its kind wait); every failure is a toast with the server's own
 * sentence.
 */
export function usePayslipActions(scope: PayrollScope) {
  const { toast } = useToast();
  const { token } = useAuth();
  const emailMutation = useEmailSalarySlip();
  const whatsappMutation = useWhatsAppSalarySlip();
  const [busy, setBusy] = useState<{ id: number; action: RowAction } | null>(null);
  const [bulk, setBulk] = useState<BulkDownload | null>(null);

  const isBusy = (row: Pick<PayslipRow, "payrollId">, action: RowAction) =>
    busy?.id === row.payrollId && busy.action === action;

  async function preview(row: PayslipRow) {
    setBusy({ id: row.payrollId, action: "preview" });
    try {
      // the saved slip's own PDF; a payroll with no saved slip is printed from the payroll itself
      const url = row.slipId ? `/api/salary-slips/${row.slipId}/pdf` : payslipsPdfUrl(scope, [row.payrollId], "single");
      await previewDocumentPdf(url, () => token);
    } catch (err) {
      toast({ title: "The payslip PDF could not be opened", description: errorText(err), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  async function download(row: PayslipRow) {
    setBusy({ id: row.payrollId, action: "download" });
    try {
      await downloadPayslipsPdf({
        scope,
        payrollIds: [row.payrollId],
        layout: "single",
        fallbackName: payslipsFileName(scope, row),
      });
    } catch (err) {
      toast({ title: "The payslip could not be downloaded", description: errorText(err), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  async function email(row: PayslipRow) {
    if (!row.slipId) return;
    setBusy({ id: row.payrollId, action: "email" });
    try {
      const result = await emailMutation.mutateAsync({ id: row.slipId });
      toast({ title: `Email sent to ${row.name}`, description: `Payslip delivered to ${result.sentTo}` });
    } catch (err) {
      toast({ title: "The payslip email was not sent", description: errorText(err), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  async function whatsapp(row: PayslipRow) {
    if (!row.slipId) return;
    setBusy({ id: row.payrollId, action: "whatsapp" });
    try {
      const result = await whatsappMutation.mutateAsync(row.slipId);
      toast(whatsappSendToast(result, row.name));
    } catch (err) {
      toast({ title: "The payslip was not sent on WhatsApp", description: errorText(err), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  /** One PDF of the payslips of `rows` (one: that employee's file name; more: the period's). */
  async function downloadMany(rows: readonly PayslipRow[], layout: PayslipLayout, which: BulkDownload) {
    if (rows.length === 0) return;
    setBulk(which);
    try {
      const name = await downloadPayslipsPdf({
        scope,
        payrollIds: rows.map((r) => r.payrollId),
        layout,
        fallbackName: payslipsFileName(scope, rows.length === 1 ? rows[0] : null),
      });
      toast({
        title: rows.length === 1 ? "Payslip downloaded" : `${rows.length} payslips downloaded`,
        description: name,
      });
    } catch (err) {
      toast({ title: "The payslips could not be downloaded", description: errorText(err), variant: "destructive" });
    } finally {
      setBulk(null);
    }
  }

  return { busy, bulk, isBusy, preview, download, email, whatsapp, downloadMany };
}

export type PayslipActions = ReturnType<typeof usePayslipActions>;
