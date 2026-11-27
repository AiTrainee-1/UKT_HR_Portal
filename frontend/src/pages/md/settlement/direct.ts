// Direct to Auditor (owner 2026-11-27): the MD finalizes the batch and it goes to the auditor at once, skipping HR Final
// Settlement. The auditor gets the same finalized report HR's Send to Auditor sends (PDF + Excel, the Loan & Advance report's
// format; a Term Loan batch the Term Loan report), so the page builds it with the HRMS's own builder
// (pages/hr/settlement/automation/files.ts), loaded only when the MD chooses Direct to Auditor. The final decisions in it
// are the MD's: what the server copies into the final settlement on a direct confirm (service.md_confirm).

import type {
  SettlementBatch as HrBatch,
  SettlementBatchItem as HrItem,
} from "@/lib/api-client/custom-hooks/settlement-automation";
import { TYPE_LABEL, baseOf } from "./logic";
import type { SettlementBatch, SettlementItem } from "./types";

export type ReportCompany = { company: string; branchLabel: string; logoDataUrl?: string | null };

/** One request as the server finalizes it on a direct confirm: the MD's decision and amount, the request's own first
 *  deduction month (and a Term Loan's own months), no auditor change yet. */
export function finalizedItem(item: SettlementItem): HrItem {
  const approved = item.md.decision === "approved";
  const amount = approved ? (item.md.amount ?? baseOf(item)) : null;
  const a = item.advance;
  return {
    ...item,
    advance: a as unknown as HrItem["advance"],
    md: { decision: item.md.decision, amount: item.md.amount, remark: item.md.remark, decidedAt: item.md.decidedAt },
    final: {
      decision: item.md.decision,
      amount,
      startMonth: a.repaymentStartMonth,
      startYear: a.repaymentStartYear,
      months: a.advanceType === "term" ? a.repaymentMonths : null,
      remark: "",
      changedFromMd: false,
    },
    auditor: { action: null, amount: null, remark: "", at: null },
    effective: { decision: item.md.decision, amount, remark: "" },
  };
}

/** The batch as it will be once the MD finalizes it (finalized now, by the MD), in the shape the HRMS builders read. */
export function finalizedByMd(batch: SettlementBatch, by: string, now: Date = new Date()): HrBatch {
  const items = batch.items.map(finalizedItem);
  const type = batch.advanceType ?? "general";
  const payable = items.reduce((s, i) => s + (i.effective.decision === "approved" ? (i.effective.amount ?? 0) : 0), 0);
  return {
    ...batch,
    advanceType: type,
    typeLabel: batch.typeLabel ?? TYPE_LABEL[type],
    title: batch.title ?? `${TYPE_LABEL[type]} · ${batch.label}`,
    tracker: batch.tracker as unknown as HrBatch["tracker"],
    amounts: { ...batch.amounts, finalApproved: payable, payable },
    finalizedAt: now.toISOString(),
    finalizedBy: by,
    auditor: {
      sentAt: null,
      sentBy: null,
      recipients: [],
      confirmedAt: null,
      confirmedBy: null,
      note: "",
      outcome: null,
      submittedAt: null,
      submittedNote: "",
      changes: 0,
      remarks: 0,
      changesAcceptedAt: null,
      changesAcceptedBy: null,
      changesNote: "",
      link: null,
    },
    accounts: { sentAt: null, sentBy: null, recipients: [], sentVia: null },
    history: (batch.history ?? []) as unknown as HrBatch["history"],
    files: [],
    items,
    actions: batch.actions as unknown as HrBatch["actions"],
  } as HrBatch;
}

/** The finalized report for the auditor, built from the MD's decisions: the two files Direct to Auditor uploads. */
export async function buildDirectFiles(
  batch: SettlementBatch,
  company: ReportCompany,
  by: string,
  now: Date = new Date(),
): Promise<{ pdf: File; xlsx: File }> {
  const { buildAuditorFiles } = await import("@/pages/hr/settlement/automation/files");
  return buildAuditorFiles(finalizedByMd(batch, by, now), company, now);
}
