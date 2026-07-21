import { useState } from "react";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { useListSalarySlips, useEmailSalarySlip, SalarySlipItem } from "@/lib/api-client";
import { previewDocumentPdf, downloadDocumentPdf } from "@/lib/api-client/custom-hooks";
import { useAuth } from "@/contexts/AuthContext";
import { useSalarySlipBulk } from "@/contexts/SalarySlipBulkContext";
import SalarySlipBulkPipeline from "@/components/SalarySlipBulkPipeline";
import {
  FileText, Download, Mail, FileSearch,
  Search, Users, Loader2, Layers, IndianRupee, TrendingUp, CheckCircle2,
} from "lucide-react";

// ─── Months ───────────────────────────────────────────────────────────────────

const MONTHS = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];
const MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function SalarySlip() {
  const { toast } = useToast();
  const { token } = useAuth();
  const emailMutation = useEmailSalarySlip();
  const today = new Date();
  const [month, setMonth]         = useState(today.getMonth() + 1);
  const [year, setYear]           = useState(today.getFullYear());
  const [tab, setTab]             = useState<"staff" | "production">("staff");
  const [prodWeek, setProdWeek]   = useState<"" | "1" | "2">("");
  const [search, setSearch]       = useState("");
  const [emailing, setEmailing]   = useState<number | null>(null);
  const [pdfBusy, setPdfBusy]     = useState<{ id: number; mode: "preview" | "download" } | null>(null);
  const { isRunning: bulkRunning, showPipeline, progress, dismiss: dismissBulkPipeline, triggerBulkDownload, triggerBulkEmail } = useSalarySlipBulk();

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

  // Month overview — based on the full tab-filtered set (not the search box),
  // since these cards describe the whole month's payroll, not a lookup.
  const totalEmployees = slips.length;
  const totalGross = slips.reduce((sum, s) => sum + s.grossSalary, 0);
  const totalDeductions = slips.reduce((sum, s) => sum + s.totalDeductions, 0);
  const totalNet = slips.reduce((sum, s) => sum + s.netSalary, 0);

  async function doPdf(slip: SalarySlipItem, mode: "preview" | "download") {
    setPdfBusy({ id: slip.id, mode });
    try {
      const url = `/api/salary-slips/${slip.id}/pdf`;
      if (mode === "preview") await previewDocumentPdf(url, () => token);
      else await downloadDocumentPdf(url, () => token);
    } catch {
      toast({ title: "Failed to generate PDF", variant: "destructive" });
    } finally {
      setPdfBusy(null);
    }
  }

  function doBulkDownload() {
    triggerBulkDownload({
      month, year, employmentType: tab,
      ...(prodWeek ? { weekNumber: Number(prodWeek) } : {}),
    });
  }

  function doBulkEmail() {
    triggerBulkEmail({
      month, year, employmentType: tab,
      ...(prodWeek ? { weekNumber: Number(prodWeek) } : {}),
    });
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
      <div className="space-y-5">
        {/* ── Page Header ─────────────────────────────────────────── */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h2 className="text-2xl font-black text-gray-900">Salary Slips</h2>
            <p className="text-sm text-gray-500 mt-0.5">
              Generate, preview, and distribute payslips
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={doBulkEmail}
              disabled={bulkRunning || slips.length === 0}
              className="flex items-center gap-2 px-4 py-2 text-sm bg-purple-600 text-white rounded-xl hover:bg-purple-700 transition-colors disabled:opacity-50"
            >
              {bulkRunning && progress?.kind === "email" ? <Loader2 size={15} className="animate-spin" /> : <Mail size={15} />}
              Bulk Send ({slips.length})
            </button>
            <button
              onClick={doBulkDownload}
              disabled={bulkRunning || slips.length === 0}
              className="flex items-center gap-2 px-4 py-2 text-sm bg-slate-800 text-white rounded-xl hover:bg-slate-900 transition-colors disabled:opacity-50"
            >
              {bulkRunning && progress?.kind === "pdf" ? <Loader2 size={15} className="animate-spin" /> : <Layers size={15} />}
              Bulk Download All ({slips.length})
            </button>
          </div>
        </div>

        {/* ── Bulk download/email progress ───────────────────────────── */}
        <SalarySlipBulkPipeline active={showPipeline} data={progress} onDismiss={dismissBulkPipeline} />

        {/* ── Month Overview ──────────────────────────────────────── */}
        {!isLoading && slips.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: "Total Employees", value: `${totalEmployees}`, color: "text-indigo-700", icon: Users, bg: "bg-indigo-50" },
              { label: "Total Gross", value: `₹${totalGross.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`, color: "text-blue-700", icon: TrendingUp, bg: "bg-blue-50" },
              { label: "Deductions", value: `₹${totalDeductions.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`, color: "text-red-600", icon: IndianRupee, bg: "bg-red-50" },
              { label: "Total Salary Amount", value: `₹${totalNet.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`, color: "text-green-700", icon: CheckCircle2, bg: "bg-green-50" },
            ].map(s => (
              <Card key={s.label} className="border-0 shadow-sm">
                <CardContent className="p-4 flex items-center gap-3">
                  <div className={`w-9 h-9 rounded-lg ${s.bg} flex items-center justify-center shrink-0`}>
                    <s.icon size={16} className={s.color} />
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">{s.label}</p>
                    <p className={`text-base font-black ${s.color}`}>{s.value}</p>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* ── Filters ─────────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-3 clay-card rounded-2xl px-4 py-3">
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
        <div className="clay-card rounded-2xl overflow-hidden">
          {/* Main tab bar */}
          <div className="clay-tabs-list">
            {(["staff","production"] as const).map(t => (
              <button
                key={t}
                onClick={() => { setTab(t); setProdWeek(""); }}
                data-state={tab === t ? "active" : "inactive"}
                className="clay-tabs-trigger flex items-center gap-2 capitalize"
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
                      icon={pdfBusy?.id === slip.id && pdfBusy.mode === "preview" ? <Loader2 size={13} className="animate-spin" /> : <FileSearch size={13} />}
                      label="View PDF"
                      onClick={() => doPdf(slip, "preview")}
                      disabled={pdfBusy !== null}
                      color="gray"
                    />
                    <ActionBtn
                      icon={pdfBusy?.id === slip.id && pdfBusy.mode === "download" ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                      label="Download PDF"
                      onClick={() => doPdf(slip, "download")}
                      disabled={pdfBusy !== null}
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
