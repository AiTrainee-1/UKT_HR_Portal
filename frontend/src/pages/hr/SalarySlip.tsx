import { useState, useRef } from "react";
import HrLayout from "@/components/HrLayout";
import { useToast } from "@/hooks/use-toast";
import { useListSalarySlips, useEmailSalarySlip, SalarySlipItem } from "@/lib/api-client";
import {
  FileText, Download, Mail, Printer, Eye, ChevronDown,
  Search, Users, Loader2, X, Layers,
} from "lucide-react";

// ─── Months ───────────────────────────────────────────────────────────────────

const MONTHS = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];
const MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// ─── Number to words (Indian system) ─────────────────────────────────────────

const ONES = ["","ONE","TWO","THREE","FOUR","FIVE","SIX","SEVEN","EIGHT","NINE","TEN",
  "ELEVEN","TWELVE","THIRTEEN","FOURTEEN","FIFTEEN","SIXTEEN","SEVENTEEN","EIGHTEEN","NINETEEN"];
const TENS = ["","","TWENTY","THIRTY","FORTY","FIFTY","SIXTY","SEVENTY","EIGHTY","NINETY"];

function convert(n: number): string {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? " " + ONES[n % 10] : "");
  if (n < 1000) return ONES[Math.floor(n / 100)] + " HUNDRED" + (n % 100 ? " " + convert(n % 100) : "");
  if (n < 100000) return convert(Math.floor(n / 1000)) + " THOUSAND" + (n % 1000 ? " " + convert(n % 1000) : "");
  if (n < 10000000) return convert(Math.floor(n / 100000)) + " LAKH" + (n % 100000 ? " " + convert(n % 100000) : "");
  return convert(Math.floor(n / 10000000)) + " CRORE" + (n % 10000000 ? " " + convert(n % 10000000) : "");
}

function numToWords(n: number): string {
  const rounded = Math.round(n);
  if (rounded === 0) return "Rs. ZERO ONLY";
  return "Rs. " + convert(rounded) + " ONLY";
}

// ─── Period string ────────────────────────────────────────────────────────────

function periodStr(slip: SalarySlipItem): string {
  const { month, year } = slip;
  const last = new Date(year, month, 0).getDate();
  return `01/${String(month).padStart(2,"0")}/${year} To ${last}/${String(month).padStart(2,"0")}/${year}`;
}

function todayStr(): string {
  const d = new Date();
  return `${String(d.getDate()).padStart(2,"0")}-${String(d.getMonth()+1).padStart(2,"0")}-${d.getFullYear()}`;
}

// ─── WageSlipTemplate: exact match to reference image ────────────────────────

function WageSlipTemplate({ slip }: { slip: SalarySlipItem }) {
  const co  = slip.slipCompanyName    || "UK TEXTILES - H.O";
  const city= slip.slipCompanyAddress || "TIRUPUR";
  const minWage = slip.minWageRate || 0;
  const sig = slip.signatureImage || null;

  const otherAllowances = slip.allowances + slip.incentives + slip.bonuses;
  const leaveRows = slip.leaveBalances && slip.leaveBalances.length > 0
    ? slip.leaveBalances
    : [{ leaveType: "Casual Leave", leaveCode: "CL", allocated: 0, used: 0, remaining: 0 }];

  const td = (content: React.ReactNode, style?: React.CSSProperties) => (
    <td style={{ border: "1px solid #000", padding: "2px 4px", fontSize: "9px", verticalAlign: "top", ...style }}>
      {content}
    </td>
  );

  return (
    <div style={{ fontFamily: "Arial, sans-serif", fontSize: "9px", color: "#000", maxWidth: "750px", margin: "0 auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", border: "2px solid #000" }}>
        {/* ── Company Header ────────────────────────── */}
        <tbody>
          <tr>
            <td colSpan={3} style={{ border: "1px solid #000", padding: "4px 8px", textAlign: "center" }}>
              <div style={{ fontWeight: "bold", fontSize: "14px", letterSpacing: "1px" }}>{co}</div>
              <div style={{ fontSize: "11px", marginTop: "1px" }}>{city}-</div>
            </td>
            <td style={{ border: "1px solid #000", padding: "4px 8px", textAlign: "right", fontSize: "9px", whiteSpace: "nowrap" }}>
              <strong>Period From</strong> {periodStr(slip)}
            </td>
          </tr>

          {/* ── Wage Slip Title ───────────────────────── */}
          <tr>
            <td colSpan={4} style={{ border: "1px solid #000", padding: "4px 8px", textAlign: "center" }}>
              <div style={{ fontWeight: "bold", fontSize: "11px" }}>
                Wage Slip/ ஊதிய ரசீது&nbsp;&nbsp; मजदूरी पचीन
              </div>
              <div style={{ fontSize: "9px" }}>
                (UNDER RULE 27(2) OF THE MIN WAGES CHENNAI RULES 1953)
              </div>
            </td>
          </tr>

          {/* ── Employee Info ──────────────────────────── */}
          <tr>
            <td colSpan={2} style={{ border: "1px solid #000", padding: "3px 6px" }}>
              <span style={{ fontSize: "8px", color: "#555" }}>Employee Code / कर्मचारी कोड / தொ.எண் &nbsp;</span>
              <strong>: {slip.employeeCode}</strong>
            </td>
            <td colSpan={2} style={{ border: "1px solid #000", padding: "3px 6px" }}>
              <span style={{ fontSize: "8px", color: "#555" }}>Designation / पद / பதவி &nbsp;</span>
              <strong>: {slip.designationTitle || "—"}</strong>
            </td>
          </tr>
          <tr>
            <td colSpan={2} style={{ border: "1px solid #000", padding: "3px 6px" }}>
              <span style={{ fontSize: "8px", color: "#555" }}>Employee Name / कर्मचारी नाम / பெயர் &nbsp;</span>
              <strong>: {slip.employeeName.toUpperCase()}</strong>
            </td>
            <td colSpan={2} style={{ border: "1px solid #000", padding: "3px 6px" }}>
              <span style={{ fontSize: "8px", color: "#555" }}>Department / विभाग / துறை &nbsp;</span>
              <strong>: {slip.departmentName || "—"}</strong>
            </td>
          </tr>

          {/* ── Column Headers ─────────────────────────── */}
          <tr>
            <td style={{ border: "1px solid #000", padding: "3px 6px", fontWeight: "bold", width: "30%", fontSize: "9px" }}>
              Earnings / ஈட்டியது ஆய
            </td>
            <td style={{ border: "1px solid #000", padding: "3px 6px", fontWeight: "bold", width: "30%", fontSize: "9px" }}>
              Deductions / &nbsp;பிடித்தம்
            </td>
            <td colSpan={2} style={{ border: "1px solid #000", padding: "3px 6px", width: "40%" }} />
          </tr>

          {/* ── Body row: Earnings | Deductions | Personal Info ── */}
          <tr>
            {/* Earnings */}
            <td style={{ border: "1px solid #000", padding: 0, verticalAlign: "top", width: "30%" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <tbody>
                  {[
                    ["Basic/ அடிப்படை சம்பளம்", "मूल वेतन", slip.basic],
                    ["DA/ பஞ்சப்படி", "महंगाई भत्ता", 0],
                    ["HRA/ வீ.வா.", "मकान किराया", slip.hra],
                    ["CA/ பயணப்படி", "दैनिक भत्ता", 0],
                    ["EA/ கல்விப்படி", "शैक्षणिक भत्ते", 0],
                    ["Other Allowances", "अन्य भत्ते", otherAllowances],
                    ["OT Wages/ சமயோபரி மஜ்தூரி", "समयोपरि मजदूरी", slip.otAmount],
                    ["PTRL", "", 0],
                  ].map(([label, sub, val]) => (
                    <tr key={String(label)}>
                      <td style={{ borderBottom: "1px solid #ccc", padding: "2px 4px", fontSize: "8px" }}>
                        {String(label)}<br/><span style={{ color: "#666", fontSize: "7px" }}>{String(sub)}</span>
                      </td>
                      <td style={{ borderBottom: "1px solid #ccc", borderLeft: "1px solid #000", padding: "2px 4px", fontSize: "9px", textAlign: "right" }}>
                        {Number(val).toFixed(2)}
                      </td>
                    </tr>
                  ))}
                  <tr style={{ fontWeight: "bold", background: "#f5f5f5" }}>
                    <td style={{ padding: "3px 4px", fontSize: "9px", borderTop: "1px solid #000" }}>
                      Total / மொத்தம் கல
                    </td>
                    <td style={{ padding: "3px 4px", fontSize: "9px", borderTop: "1px solid #000", borderLeft: "1px solid #000", textAlign: "right" }}>
                      {slip.grossSalary.toFixed(2)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </td>

            {/* Deductions */}
            <td style={{ border: "1px solid #000", padding: 0, verticalAlign: "top", width: "30%" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <tbody>
                  {[
                    ["P.F/ பி.எப்.", "पी.एफ.", slip.pfDeduction],
                    ["E.S.I/ இ.எஸ்.ஐ.", "इ.एस.आई.", slip.esiDeduction],
                    ["Advance/ முன்பணம்", "अग्रिम", slip.advanceDeduction],
                    ["T.Advance/ கடன்", "ऋण", 0],
                    ["TDS", "", 0],
                    ["Lop & PSAmt/ ஊதியக் குறைப்பு", "", 0],
                    ["Others/ இதரவகை", "अन्य", slip.otherDeductions],
                  ].map(([label, sub, val]) => (
                    <tr key={String(label)}>
                      <td style={{ borderBottom: "1px solid #ccc", padding: "2px 4px", fontSize: "8px" }}>
                        {String(label)}<br/><span style={{ color: "#666", fontSize: "7px" }}>{String(sub)}</span>
                      </td>
                      <td style={{ borderBottom: "1px solid #ccc", borderLeft: "1px solid #000", padding: "2px 4px", fontSize: "9px", textAlign: "right" }}>
                        {Number(val).toFixed(2)}
                      </td>
                    </tr>
                  ))}
                  <tr style={{ fontWeight: "bold", background: "#f5f5f5" }}>
                    <td style={{ padding: "3px 4px", fontSize: "9px", borderTop: "1px solid #000" }}>
                      Total / மொத்தம் கல
                    </td>
                    <td style={{ padding: "3px 4px", fontSize: "9px", borderTop: "1px solid #000", borderLeft: "1px solid #000", textAlign: "right" }}>
                      {slip.totalDeductions.toFixed(2)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </td>

            {/* Personal Info */}
            <td colSpan={2} style={{ border: "1px solid #000", padding: "4px 6px", verticalAlign: "top", width: "40%", fontSize: "8.5px" }}>
              <div style={{ marginBottom: "3px" }}>
                <span style={{ fontSize: "8px", color: "#555" }}>Father's / Husband's Name</span><br/>
                <span style={{ fontSize: "7px", color: "#666" }}>தந்தை / கணவர் பெயர்</span><br/>
                <strong>: {(slip.fatherName || "—").toUpperCase()}</strong>
              </div>
              <div style={{ marginBottom: "3px" }}>
                <span style={{ fontSize: "8px", color: "#555" }}>Date of entry into service</span><br/>
                <span style={{ fontSize: "7px", color: "#666" }}>வேலையில் சேர்ந்த தேதி</span><br/>
                <strong>: {slip.joinDate || "—"}</strong>
              </div>
              <div style={{ marginBottom: "3px" }}>
                <span style={{ fontSize: "8px", color: "#555" }}>No.of Shifts Worked</span><br/>
                <span style={{ fontSize: "7px", color: "#666" }}>மொத்த வேலை நாட்கள்</span><br/>
                <strong>: {slip.weekNumber ? slip.completedSessions : slip.presentDays}</strong>
              </div>
              <div style={{ marginBottom: "3px" }}>
                <span style={{ fontSize: "8px", color: "#555" }}>OT / மிக நேரம் समय पर</span><br/>
                <strong>: {slip.otAmount.toFixed(2)}</strong>
              </div>
              <div style={{ marginBottom: "3px" }}>
                <span style={{ fontSize: "8px", color: "#555" }}>Min Rate of Wages</span><br/>
                <span style={{ fontSize: "7px", color: "#666" }}>குறைந்தபட்ச ஊதியம்</span><br/>
                <strong>: &nbsp;{minWage > 0 ? minWage.toLocaleString("en-IN", { minimumFractionDigits: 2 }) : ""}</strong>
              </div>
              <div style={{ marginBottom: "3px" }}>
                <span style={{ fontSize: "8px", color: "#555" }}>P.F.No / பி.எப்-எண் सं.पी.एफ.</span><br/>
                <strong>: {slip.pfNumber || ""}</strong>
              </div>
              <div style={{ marginBottom: "4px" }}>
                <span style={{ fontSize: "8px", color: "#555" }}>E.S.I No / இ.எஸ்.ஐ. எண்</span><br/>
                <strong>: {slip.esiNumber || ""}</strong>
              </div>

              {/* Leave Balance table */}
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "8px" }}>
                <thead>
                  <tr style={{ background: "#f0f0f0" }}>
                    <th style={{ border: "1px solid #000", padding: "2px", textAlign: "center" }}>Leave Type</th>
                    <th style={{ border: "1px solid #000", padding: "2px", textAlign: "center" }}>Total</th>
                    <th style={{ border: "1px solid #000", padding: "2px", textAlign: "center" }}>Utilized</th>
                    <th style={{ border: "1px solid #000", padding: "2px", textAlign: "center" }}>Cur. Util.</th>
                    <th style={{ border: "1px solid #000", padding: "2px", textAlign: "center" }}>Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {leaveRows.map(lb => (
                    <tr key={lb.leaveCode}>
                      <td style={{ border: "1px solid #000", padding: "2px", textAlign: "center" }}>{lb.leaveType}</td>
                      <td style={{ border: "1px solid #000", padding: "2px", textAlign: "center" }}>{lb.allocated.toFixed(2)}</td>
                      <td style={{ border: "1px solid #000", padding: "2px", textAlign: "center" }}>{lb.used.toFixed(2)}</td>
                      <td style={{ border: "1px solid #000", padding: "2px", textAlign: "center" }}>0.00</td>
                      <td style={{ border: "1px solid #000", padding: "2px", textAlign: "center" }}>{lb.remaining.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </td>
          </tr>

          {/* ── Net Amount ────────────────────────────────── */}
          <tr>
            <td colSpan={2} style={{ border: "1px solid #000", padding: "3px 6px" }}>
              <strong>Net Amount Paid</strong>
              <span style={{ fontSize: "8px", color: "#555" }}>&nbsp;&nbsp;நிகர தொகை கुल राशि</span>
              &nbsp;&nbsp;<strong>: &nbsp;{slip.netSalary.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</strong>
            </td>
            <td colSpan={2} style={{ border: "1px solid #000", padding: "3px 6px", textAlign: "right" }}>
              {/* signature preview area */}
            </td>
          </tr>
          <tr>
            <td colSpan={4} style={{ border: "1px solid #000", padding: "3px 6px" }}>
              <span style={{ fontSize: "8.5px" }}><strong>In words : </strong>{numToWords(slip.netSalary)}</span>
            </td>
          </tr>

          {/* ── Footer: Date | Signatures ─────────────────── */}
          <tr>
            <td style={{ border: "1px solid #000", padding: "6px 8px", verticalAlign: "bottom", width: "25%" }}>
              <div style={{ fontSize: "8px", color: "#555" }}>Employee's Signature</div>
              <div style={{ fontSize: "7px", color: "#666", marginTop: "1px" }}>தொழிலாளர் கையொப்பம்<br/>कर्मचारी के हस ताक्षर</div>
              <div style={{ height: "28px" }} />
            </td>
            <td style={{ border: "1px solid #000", padding: "6px 8px", verticalAlign: "top", textAlign: "center", width: "25%" }}>
              <div style={{ fontSize: "8.5px", fontWeight: "bold" }}>Date of Payment</div>
              <div style={{ fontSize: "7px", color: "#666" }}>கொடுக்கப்பட்ட தேதி<br/>भुगतान की तारीख</div>
              <div style={{ fontSize: "9px", fontWeight: "bold", marginTop: "4px" }}>: {todayStr()}</div>
            </td>
            <td colSpan={2} style={{ border: "1px solid #000", padding: "6px 8px", verticalAlign: "top", textAlign: "center", width: "50%" }}>
              {sig ? (
                <img src={sig} alt="Signature" style={{ height: "36px", objectFit: "contain", display: "block", margin: "0 auto" }} />
              ) : (
                <div style={{ height: "36px" }} />
              )}
              <div style={{ fontSize: "8.5px", fontWeight: "bold", marginTop: "2px" }}>Proprietor</div>
              <div style={{ fontSize: "7px", color: "#555" }}>நிர்வாகத்திற்காக<br/>हस ताक्षर प्राधिकृत किया।</div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ─── Print utilities ──────────────────────────────────────────────────────────

function buildPrintHtml(slips: SalarySlipItem[], onePerPage = true): string {
  // We use a temporary div to render each slip to HTML
  // Instead, we pass the IDs to a print route — but since we have no router for this,
  // we'll use renderToStaticMarkup-style approach via innerHTML
  return slips.map((s, i) => {
    const isLast = i === slips.length - 1;
    return `<div class="slip-page" style="${onePerPage && !isLast ? "page-break-after:always;" : ""}">${
      // Placeholder — will be replaced with actual DOM content
      `__SLIP_${s.id}__`
    }</div>`;
  }).join("");
}

function printSlips(slips: SalarySlipItem[]) {
  const iframe = document.createElement("iframe");
  iframe.style.cssText = "position:fixed;top:-9999px;left:-9999px;width:210mm;height:297mm;border:none;";
  document.body.appendChild(iframe);

  const doc = iframe.contentDocument!;
  doc.open();
  doc.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Salary Slips</title>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body { font-family: Arial, sans-serif; font-size: 9px; background: #fff; color: #000; }
      .slip-page { padding: 10mm; }
      @media print {
        @page { size: A4; margin: 8mm; }
        .slip-page { padding: 0; page-break-after: always; }
        .slip-page:last-child { page-break-after: avoid; }
      }
    </style>
  </head><body id="print-body"></body></html>`);
  doc.close();

  // Mount each slip via a temporary React root is complex in an iframe.
  // Instead, clone the rendered DOM from the current page.
  const body = doc.getElementById("print-body")!;
  slips.forEach((slip, idx) => {
    const el = document.getElementById(`wage-slip-${slip.id}`);
    if (el) {
      const wrapper = doc.createElement("div");
      wrapper.className = "slip-page";
      wrapper.innerHTML = el.innerHTML;
      if (idx < slips.length - 1) {
        wrapper.style.pageBreakAfter = "always";
      }
      body.appendChild(wrapper);
    }
  });

  setTimeout(() => {
    iframe.contentWindow?.print();
    setTimeout(() => document.body.removeChild(iframe), 1000);
  }, 400);
}

// ─── SlipModal ────────────────────────────────────────────────────────────────

function SlipModal({ slip, onClose, onPrint }: { slip: SalarySlipItem; onClose: () => void; onPrint: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100">
          <span className="font-semibold text-gray-800 text-sm">
            Salary Slip — {slip.employeeName} · {MONTHS_SHORT[slip.month-1]} {slip.year}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={onPrint}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              <Printer size={13} /> Print / PDF
            </button>
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100">
              <X size={16} />
            </button>
          </div>
        </div>
        <div className="overflow-auto p-5">
          <div id={`wage-slip-${slip.id}`}>
            <WageSlipTemplate slip={slip} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function SalarySlip() {
  const { toast } = useToast();
  const emailMutation = useEmailSalarySlip();
  const today = new Date();
  const [month, setMonth]         = useState(today.getMonth() + 1);
  const [year, setYear]           = useState(today.getFullYear());
  const [tab, setTab]             = useState<"staff" | "production">("staff");
  const [prodWeek, setProdWeek]   = useState<"" | "1" | "2">("");
  const [search, setSearch]       = useState("");
  const [viewSlip, setViewSlip]   = useState<SalarySlipItem | null>(null);
  const [printing, setPrinting]   = useState<number | null>(null);
  const [emailing, setEmailing]   = useState<number | null>(null);
  const hiddenRef                 = useRef<HTMLDivElement>(null);

  const { data: slips = [], isLoading } = useListSalarySlips({
    month,
    year,
    employmentType: tab,
    ...(prodWeek ? { weekNumber: Number(prodWeek) } : {}),
  });

  const filtered = slips.filter(s => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      s.employeeName.toLowerCase().includes(q) ||
      s.employeeCode.toLowerCase().includes(q)
    );
  });

  function doPrint(slip: SalarySlipItem) {
    setPrinting(slip.id);
    // Give DOM time to render the hidden slips div
    setTimeout(() => {
      printSlips([slip]);
      setTimeout(() => setPrinting(null), 600);
    }, 100);
  }

  function doBulkPrint() {
    setPrinting(-1);
    setTimeout(() => {
      printSlips(filtered);
      setTimeout(() => setPrinting(null), 600);
    }, 100);
  }

  async function doEmail(slip: SalarySlipItem) {
    setEmailing(slip.id);
    try {
      const result = await emailMutation.mutateAsync({ id: slip.id });
      toast({
        title: `Email sent to ${slip.employeeName}`,
        description: `Salary slip delivered to ${result.sentTo}`,
      });
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || "Unknown error";
      toast({ title: "Failed to send email", description: msg, variant: "destructive" });
    } finally {
      setEmailing(null);
    }
  }

  return (
    <HrLayout>
      {/* Hidden render zone for all slips (used by printSlips) */}
      <div ref={hiddenRef} style={{ position: "fixed", left: "-99999px", top: 0, width: "750px", opacity: 0, pointerEvents: "none" }} aria-hidden>
        {filtered.map(s => (
          <div key={s.id} id={`wage-slip-${s.id}`}>
            <WageSlipTemplate slip={s} />
          </div>
        ))}
      </div>

      <div className="space-y-5">
        {/* ── Page Header ─────────────────────────────────────────── */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-black text-gray-900">Salary Slips</h2>
            <p className="text-sm text-gray-500 mt-0.5">
              Generate and distribute payslips — bilingual format (English / Tamil)
            </p>
          </div>
          <button
            onClick={doBulkPrint}
            disabled={printing !== null || filtered.length === 0}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-slate-800 text-white rounded-xl hover:bg-slate-900 transition-colors disabled:opacity-50"
          >
            {printing === -1 ? <Loader2 size={15} className="animate-spin" /> : <Layers size={15} />}
            Bulk Print All ({filtered.length})
          </button>
        </div>

        {/* ── Filters ─────────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-3 bg-white rounded-2xl border border-gray-100 shadow-sm px-4 py-3">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-gray-400">Month</span>
            <select
              value={month}
              onChange={e => setMonth(Number(e.target.value))}
              className="text-sm border border-gray-200 rounded-lg px-2 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {MONTHS.map((m, i) => <option key={i} value={i+1}>{m}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-gray-400">Year</span>
            <select
              value={year}
              onChange={e => setYear(Number(e.target.value))}
              className="text-sm border border-gray-200 rounded-lg px-2 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {[2024, 2025, 2026, 2027].map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
          <div className="ml-auto relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="Search employee…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-8 pr-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 w-48"
            />
          </div>
        </div>

        {/* ── Tabs ─────────────────────────────────────────────────── */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
          {/* Main tab bar */}
          <div className="flex border-b border-gray-100">
            {(["staff","production"] as const).map(t => (
              <button
                key={t}
                onClick={() => { setTab(t); setProdWeek(""); }}
                className={`flex items-center gap-2 px-6 py-3.5 text-sm font-medium border-b-2 transition-colors capitalize ${
                  tab === t
                    ? "border-blue-600 text-blue-600 bg-blue-50/50"
                    : "border-transparent text-gray-500 hover:text-gray-800"
                }`}
              >
                <Users size={14} />
                {t === "staff" ? "Staff" : "Production"}
              </button>
            ))}
          </div>

          {/* Production sub-tabs */}
          {tab === "production" && (
            <div className="flex gap-2 px-4 py-2 bg-amber-50 border-b border-amber-100">
              {([["","All Weeks"], ["1","Week 1 & 2 (1–15)"], ["2","Week 3 & 4 (16–end)"]] as const).map(([val, label]) => (
                <button
                  key={val}
                  onClick={() => setProdWeek(val)}
                  className={`px-3 py-1 text-xs rounded-lg transition-colors ${
                    prodWeek === val
                      ? "bg-amber-500 text-white"
                      : "bg-white text-amber-700 border border-amber-200 hover:bg-amber-100"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}

          {/* Slip list */}
          <div className="divide-y divide-gray-50">
            {isLoading ? (
              <div className="flex items-center justify-center py-20 text-gray-400">
                <Loader2 size={24} className="animate-spin mr-3" />
                <span className="text-sm">Loading salary slips…</span>
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-gray-400">
                <FileText size={40} className="opacity-20 mb-3" />
                <p className="text-sm">No salary slips found for the selected period.</p>
                <p className="text-xs mt-1 text-gray-400">Generate payroll first, then slips will appear here.</p>
              </div>
            ) : (
              filtered.map(slip => (
                <div
                  key={slip.id}
                  className="flex items-center gap-4 px-5 py-3.5 hover:bg-gray-50/60 transition-colors"
                >
                  {/* Avatar */}
                  <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white text-xs font-bold shrink-0">
                    {slip.employeeName.charAt(0)}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-sm text-gray-900 truncate">{slip.employeeName}</p>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {slip.employeeCode}
                      {slip.designationTitle ? ` · ${slip.designationTitle}` : ""}
                      {slip.departmentName ? ` · ${slip.departmentName}` : ""}
                      {slip.weekNumber ? ` · W${slip.weekNumber}` : ""}
                    </p>
                  </div>

                  {/* Net salary badge */}
                  <div className="text-right shrink-0">
                    <p className="text-sm font-bold text-gray-900">
                      ₹{slip.netSalary.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                    </p>
                    <p className="text-xs text-gray-400">
                      {MONTHS_SHORT[slip.month-1]} {slip.year}
                    </p>
                  </div>

                  {/* Action buttons */}
                  <div className="flex items-center gap-1.5 shrink-0">
                    <ActionBtn
                      icon={<Eye size={13} />}
                      label="View"
                      onClick={() => setViewSlip(slip)}
                      color="gray"
                    />
                    <ActionBtn
                      icon={printing === slip.id ? <Loader2 size={13} className="animate-spin" /> : <Printer size={13} />}
                      label="Print"
                      onClick={() => doPrint(slip)}
                      disabled={printing !== null}
                      color="blue"
                    />
                    <ActionBtn
                      icon={<Download size={13} />}
                      label="PDF"
                      onClick={() => doPrint(slip)}
                      disabled={printing !== null}
                      color="green"
                    />
                    <ActionBtn
                      icon={emailing === slip.id ? <Loader2 size={13} className="animate-spin" /> : <Mail size={13} />}
                      label="Email"
                      onClick={() => doEmail(slip)}
                      disabled={emailing !== null}
                      color="purple"
                    />
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Footer count */}
          {filtered.length > 0 && (
            <div className="px-5 py-3 border-t border-gray-100 bg-gray-50/50 text-xs text-gray-400">
              {filtered.length} salary slip{filtered.length !== 1 ? "s" : ""} ·
              Total Net: ₹{filtered.reduce((s,r) => s + r.netSalary, 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}
            </div>
          )}
        </div>
      </div>

      {/* View Modal */}
      {viewSlip && (
        <SlipModal
          slip={viewSlip}
          onClose={() => setViewSlip(null)}
          onPrint={() => doPrint(viewSlip)}
        />
      )}
    </HrLayout>
  );
}

// ─── Helper components ────────────────────────────────────────────────────────

function ActionBtn({
  icon, label, onClick, disabled = false, color,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  color: "gray" | "blue" | "green" | "purple";
}) {
  const colors = {
    gray:   "border-gray-200 text-gray-600 hover:bg-gray-50",
    blue:   "border-blue-200 text-blue-700 hover:bg-blue-50",
    green:  "border-green-200 text-green-700 hover:bg-green-50",
    purple: "border-purple-200 text-purple-700 hover:bg-purple-50",
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-1 px-2.5 py-1.5 text-xs border rounded-lg transition-colors disabled:opacity-40 ${colors[color]}`}
    >
      {icon}
      {label}
    </button>
  );
}
