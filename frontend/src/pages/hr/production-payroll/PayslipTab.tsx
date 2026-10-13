import { useState } from "react";
import {
  CheckCircle2,
  Download,
  FileSearch,
  IndianRupee,
  Layers,
  Loader2,
  Mail,
  MessageCircle,
  Search,
  TrendingUp,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import SalarySlipBulkPipeline from "@/components/SalarySlipBulkPipeline";
import WhatsAppBulkPipeline from "@/components/WhatsAppBulkPipeline";
import { MONTH_NAMES } from "@/components/payroll/BreakdownDrawer";
import { useAuth } from "@/contexts/AuthContext";
import { useSalarySlipBulk } from "@/contexts/SalarySlipBulkContext";
import { useWhatsAppBulk } from "@/contexts/WhatsAppBulkContext";
import { useToast } from "@/hooks/use-toast";
import { useEmailSalarySlip, useListSalarySlips, type SalarySlipItem } from "@/lib/api-client";
import {
  PAY_CYCLE_INFO,
  downloadDocumentPdf,
  previewDocumentPdf,
  useWhatsAppSalarySlip,
  type PayCycle,
} from "@/lib/api-client/custom-hooks";
import { rupees } from "./logic";

/**
 * Payslip tab of a cycle page: the salary slips of the cycle for a month (a slip belongs to the month its period ends
 * in), with the PDF / email / WhatsApp actions and the bulk versions of them, all limited to this cycle's slips.
 */
export function PayslipTab({ cycle }: { cycle: PayCycle }) {
  const { toast } = useToast();
  const { token } = useAuth();
  const info = PAY_CYCLE_INFO[cycle];
  const emailMutation = useEmailSalarySlip();
  const whatsappMutation = useWhatsAppSalarySlip();
  const today = new Date();
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [year, setYear] = useState(today.getFullYear());
  const [search, setSearch] = useState("");
  const [emailing, setEmailing] = useState<number | null>(null);
  const [whatsapping, setWhatsapping] = useState<number | null>(null);
  const [pdfBusy, setPdfBusy] = useState<{ id: number; mode: "preview" | "download" } | null>(null);
  const {
    isRunning: bulkRunning,
    showPipeline,
    progress,
    dismiss: dismissBulkPipeline,
    triggerBulkDownload,
    triggerBulkEmail,
  } = useSalarySlipBulk();
  const {
    isRunning: whatsappBulkRunning,
    showPipeline: showWhatsappPipeline,
    progress: whatsappProgress,
    dismiss: dismissWhatsappPipeline,
    triggerBulkWhatsApp,
  } = useWhatsAppBulk();

  const { data: slips = [], isLoading } = useListSalarySlips({
    month,
    year,
    employmentType: "production",
    payCycle: cycle,
  });
  const filter = { month, year, employmentType: "production" as const, payCycle: cycle };

  const filtered = slips.filter((s) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return s.employeeName.toLowerCase().includes(q) || s.employeeCode.toLowerCase().includes(q);
  });

  const totalEmployees = new Set(slips.map((s) => s.employeeId)).size;
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

  async function doEmail(slip: SalarySlipItem) {
    setEmailing(slip.id);
    try {
      const result = await emailMutation.mutateAsync({ id: slip.id });
      toast({ title: `Email sent to ${slip.employeeName}`, description: `Salary slip delivered to ${result.sentTo}` });
    } catch (err) {
      toast({
        title: "Failed to send email",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setEmailing(null);
    }
  }

  async function doWhatsApp(slip: SalarySlipItem) {
    setWhatsapping(slip.id);
    try {
      const result = await whatsappMutation.mutateAsync(slip.id);
      toast({
        title: `WhatsApp sent to ${slip.employeeName}`,
        description: `Salary slip delivered to ${result.sentTo}`,
      });
    } catch (err) {
      toast({
        title: "Failed to send via WhatsApp",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setWhatsapping(null);
    }
  }

  const overview = [
    { label: "Employees", value: `${totalEmployees}`, color: "text-indigo-700", icon: Users, bg: "bg-indigo-50" },
    { label: "Total Gross", value: rupees(totalGross), color: "text-blue-700", icon: TrendingUp, bg: "bg-blue-50" },
    { label: "Deductions", value: rupees(totalDeductions), color: "text-red-600", icon: IndianRupee, bg: "bg-red-50" },
    {
      label: "Total Salary Amount",
      value: rupees(totalNet),
      color: "text-green-700",
      icon: CheckCircle2,
      bg: "bg-green-50",
    },
  ];

  return (
    <div className="space-y-4" data-testid="pcp-payslip-tab">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <select
            value={month}
            onChange={(e) => setMonth(Number(e.target.value))}
            className="h-8 rounded-md border bg-background px-3 text-sm"
            aria-label="Month"
          >
            {MONTH_NAMES.map((m, i) => (
              <option key={m} value={i + 1}>
                {m}
              </option>
            ))}
          </select>
          <Input
            type="number"
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className="h-8 w-20 text-sm"
            min={2020}
            max={2040}
            aria-label="Year"
          />
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search employee…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 w-56 pl-8 text-sm"
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-2 border-purple-200 text-purple-700 hover:bg-purple-50"
            disabled={bulkRunning || slips.length === 0}
            onClick={() => triggerBulkEmail(filter)}
          >
            {bulkRunning && progress?.kind === "email" ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Mail size={13} />
            )}
            Bulk Send ({slips.length})
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-2 border-emerald-200 text-emerald-700 hover:bg-emerald-50"
            disabled={whatsappBulkRunning || slips.length === 0}
            onClick={() => triggerBulkWhatsApp(filter)}
          >
            {whatsappBulkRunning ? <Loader2 size={13} className="animate-spin" /> : <MessageCircle size={13} />}
            Bulk WhatsApp ({slips.length})
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-2"
            disabled={bulkRunning || slips.length === 0}
            onClick={() => triggerBulkDownload(filter)}
          >
            {bulkRunning && progress?.kind === "pdf" ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Layers size={13} />
            )}
            Bulk Download ({slips.length})
          </Button>
        </div>
      </div>

      <SalarySlipBulkPipeline active={showPipeline} data={progress} onDismiss={dismissBulkPipeline} />
      <WhatsAppBulkPipeline active={showWhatsappPipeline} data={whatsappProgress} onDismiss={dismissWhatsappPipeline} />

      {!isLoading && slips.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {overview.map((s) => (
            <Card key={s.label} className="border-0 shadow-sm">
              <CardContent className="flex items-center gap-3 p-4">
                <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${s.bg}`}>
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

      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-3 py-2 text-left font-semibold text-gray-600">Employee</th>
              <th className="px-3 py-2 text-left font-semibold text-gray-600">Period</th>
              <th className="px-3 py-2 text-left font-semibold text-gray-600">Net Salary</th>
              <th className="px-3 py-2 text-right font-semibold text-gray-600">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}>
                  <td colSpan={4} className="px-3 py-2">
                    <Skeleton className="h-6 w-full" />
                  </td>
                </tr>
              ))
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={4} className="py-10 text-center text-xs text-muted-foreground">
                  No {info.label} payslips for {MONTH_NAMES[month - 1]} {year}.
                </td>
              </tr>
            ) : (
              filtered.map((s) => (
                <tr key={s.id} className="hover:bg-gray-50/50" data-testid={`pcp-slip-row-${s.id}`}>
                  <td className="px-3 py-2">
                    <p className="font-semibold text-gray-900">{s.employeeName}</p>
                    <p className="font-mono text-xs text-muted-foreground">{s.employeeCode}</p>
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-600">
                    {s.periodStart && s.periodEnd ? `${s.periodStart} – ${s.periodEnd}` : s.slipNumber}
                  </td>
                  <td className="px-3 py-2 font-bold text-green-700">{rupees(s.netSalary)}</td>
                  <td className="px-3 py-2 text-right">
                    <div className="inline-flex items-center gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        title="Preview the payslip"
                        aria-label={`Preview the payslip of ${s.employeeName}`}
                        disabled={pdfBusy?.id === s.id}
                        onClick={() => doPdf(s, "preview")}
                      >
                        <FileSearch size={13} />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        title="Download the payslip"
                        aria-label={`Download the payslip of ${s.employeeName}`}
                        disabled={pdfBusy?.id === s.id}
                        onClick={() => doPdf(s, "download")}
                      >
                        <Download size={13} />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        title="Send the payslip by email"
                        aria-label={`Send the payslip of ${s.employeeName} by email`}
                        disabled={emailing === s.id}
                        onClick={() => doEmail(s)}
                      >
                        <Mail size={13} />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-emerald-600 hover:text-emerald-700"
                        title="Send the payslip on WhatsApp"
                        aria-label={`Send the payslip of ${s.employeeName} on WhatsApp`}
                        disabled={whatsapping === s.id}
                        onClick={() => doWhatsApp(s)}
                      >
                        <MessageCircle size={13} />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
