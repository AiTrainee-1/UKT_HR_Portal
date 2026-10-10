// A printable statement for one advance: who, how much, what is recovered, and the deduction schedule. It is built as
// plain HTML and printed from a hidden frame, so the browser's own "Save as PDF" gives HR a file as well.

import type { AdvanceRepaymentItem } from "@/lib/api-client";
import { STATUS_LABEL, TYPE_LABEL, hasLeft, progressPct, type SettlementRow } from "./logic";
import { MONTH_FULL, formatDate, formatDateTime, formatMoney } from "./shared";

const esc = (v: string | number | null | undefined): string =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

const row = (label: string, value: string) => `<tr><th>${esc(label)}</th><td>${esc(value) || "-"}</td></tr>`;

/** The whole statement page. `repayments` come from the advance's detail (the list does not carry them). */
export function buildStatementHtml(a: SettlementRow, repayments: AdvanceRepaymentItem[], now = new Date()): string {
  const scheduled = repayments.reduce((s, r) => s + (r.isProcessed ? 0 : r.amount), 0);
  const schedule = repayments
    .map(
      (r) =>
        `<tr><td>${esc(MONTH_FULL[r.month - 1])} ${esc(r.year)}</td><td class="n">${esc(formatMoney(r.amount))}</td><td>${
          r.isProcessed ? "Deducted via payroll" : "Scheduled"
        }</td></tr>`,
    )
    .join("");
  const left = hasLeft(a)
    ? `<p class="note">The employee has left. The outstanding ${esc(formatMoney(a.outstanding))} is to be settled in their full and final settlement.</p>`
    : "";
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Advance statement: ${esc(a.employeeName)}</title>
<style>
  body{font:13px/1.45 Arial,Helvetica,sans-serif;color:#111;margin:32px}
  h1{font-size:20px;margin:0}
  .sub{color:#555;margin:2px 0 18px}
  h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#555;margin:22px 0 6px}
  table{border-collapse:collapse;width:100%}
  th,td{border:1px solid #ccc;padding:6px 9px;text-align:left;vertical-align:top}
  th{width:34%;background:#f4f4f4;font-weight:600}
  .grid th{width:auto}
  .n{text-align:right;white-space:nowrap}
  .note{border:1px solid #e0a83a;background:#fff8e6;padding:8px 10px;margin-top:14px}
  .foot{margin-top:26px;color:#777;font-size:11px}
  @media print{body{margin:14mm}}
</style></head><body>
<h1>Advance statement</h1>
<p class="sub">${esc(TYPE_LABEL[a.advanceType])} &middot; ${esc(STATUS_LABEL[a.status])} &middot; printed ${esc(formatDateTime(now.toISOString()))}</p>
<h2>Employee</h2>
<table>
${row("Name", a.employeeName)}${row("Employee code", a.employeeCode)}${row("Department", a.employeeDepartment ?? "")}${row("Designation", a.employeeDesignation ?? "")}${row("Branch", a.employeeBranch ?? "")}
</table>
<h2>Advance</h2>
<table>
${row("Amount", formatMoney(a.amount))}${row("Recovered so far", `${formatMoney(a.totalRepaid)} (${progressPct(a)}%)`)}${row("Outstanding", formatMoney(a.outstanding))}${row("Purpose", a.purpose ?? "")}${
    a.advanceType === "term"
      ? row("Monthly EMI", formatMoney(a.emiAmount)) +
        row("Repayment months", a.repaymentMonths ? String(a.repaymentMonths) : "")
      : ""
  }${row("Raised on", formatDate(a.createdAt))}${row("Approved by", a.approvedBy ?? "")}${row("Approved on", formatDate(a.approvedAt))}${row("Notes", a.notes ?? "")}
</table>
${left}
<h2>Deduction schedule${repayments.length ? ` (${repayments.length})` : ""}</h2>
${
  repayments.length
    ? `<table class="grid"><thead><tr><th>Month</th><th class="n">Amount</th><th>Status</th></tr></thead><tbody>${schedule}</tbody></table>
<p>Still scheduled: <strong>${esc(formatMoney(scheduled))}</strong></p>`
    : "<p>No deduction schedule has been created for this advance.</p>"
}
<p class="foot">Deductions are made automatically through monthly payroll. Generated from the HR portal.</p>
</body></html>`;
}

/** Opens the print dialog for the statement without leaving the page. */
export function printStatement(html: string): void {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  const win = frame.contentWindow;
  if (!doc || !win) {
    frame.remove();
    return;
  }
  doc.open();
  doc.write(html);
  doc.close();
  win.addEventListener("afterprint", () => frame.remove());
  // some browsers never fire afterprint for a hidden frame
  window.setTimeout(() => frame.remove(), 60_000);
  win.focus();
  win.print();
}
