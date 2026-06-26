import { useState } from "react";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { downloadReportCsv } from "@/lib/api-client";
import {
  BarChart3, Download, FileSpreadsheet, FileText,
  Calendar, Users, IndianRupee, Clock, Building2, Briefcase,
} from "lucide-react";

type ReportDef = {
  id: string;
  title: string;
  description: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  color: string;
  params: { label: string; type: string; key: string }[];
  supported: boolean;
};

const REPORTS: ReportDef[] = [
  {
    id: "attendance", title: "Attendance Report", icon: Clock, color: "text-blue-600 bg-blue-50",
    description: "Daily punch logs, working hours, and biometric data",
    params: [
      { label: "From Date", type: "date", key: "dateFrom" },
      { label: "To Date",   type: "date", key: "dateTo" },
    ],
    supported: true,
  },
  {
    id: "leave", title: "Leave Report", icon: Calendar, color: "text-amber-600 bg-amber-50",
    description: "Leave applications, approvals, rejections, and balances",
    params: [
      { label: "Year", type: "number", key: "year" },
    ],
    supported: true,
  },
  {
    id: "payroll", title: "Payroll Report", icon: IndianRupee, color: "text-green-600 bg-green-50",
    description: "Salary processed, deductions, and net pay per employee",
    params: [
      { label: "Month (1-12)", type: "number", key: "month" },
      { label: "Year",         type: "number", key: "year" },
    ],
    supported: true,
  },
  {
    id: "employees", title: "Employee Report", icon: Users, color: "text-purple-600 bg-purple-50",
    description: "Full employee master with personal, salary, and contact info",
    params: [],
    supported: true,
  },
  {
    id: "department", title: "Department Report", icon: Building2, color: "text-cyan-600 bg-cyan-50",
    description: "Department-wise headcount and attendance summary",
    params: [
      { label: "From Date", type: "date", key: "dateFrom" },
      { label: "To Date",   type: "date", key: "dateTo" },
    ],
    supported: false,
  },
  {
    id: "salary_slip", title: "Salary Slip Report", icon: FileText, color: "text-rose-600 bg-rose-50",
    description: "Month-wise salary slip generation status",
    params: [
      { label: "Month", type: "number", key: "month" },
      { label: "Year",  type: "number", key: "year" },
    ],
    supported: false,
  },
  {
    id: "recruitment", title: "Recruitment Report", icon: Briefcase, color: "text-indigo-600 bg-indigo-50",
    description: "Applicant funnel: applied, shortlisted, interviewed, offered, joined",
    params: [
      { label: "From Date", type: "date", key: "dateFrom" },
      { label: "To Date",   type: "date", key: "dateTo" },
    ],
    supported: false,
  },
  {
    id: "shift", title: "Shift Report", icon: Clock, color: "text-teal-600 bg-teal-50",
    description: "Shift-wise attendance and overtime summary",
    params: [
      { label: "From Date", type: "date", key: "dateFrom" },
      { label: "To Date",   type: "date", key: "dateTo" },
    ],
    supported: false,
  },
];

export default function Reports() {
  const { toast } = useToast();
  const [selected, setSelected] = useState<ReportDef | null>(null);
  const [params, setParams] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState<string | null>(null);

  const downloadReport = async (format: "csv" | "excel" | "pdf") => {
    if (!selected) return;

    if (!selected.supported) {
      toast({ title: `${selected.title} export is coming soon`, variant: "default" });
      return;
    }

    if (format === "pdf") {
      toast({ title: "PDF export is not yet available", variant: "default" });
      return;
    }

    setLoading(format);
    try {
      await downloadReportCsv(selected.id, params);
      toast({ title: `${selected.title} downloaded as CSV` });
    } catch (err) {
      toast({
        title: "Download failed",
        description: err instanceof Error ? err.message : "Please try again",
        variant: "destructive",
      });
    } finally {
      setLoading(null);
    }
  };

  return (
    <HrLayout>
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-black text-gray-900">Reports</h2>
          <p className="text-muted-foreground text-sm mt-0.5">Generate and export HR reports in CSV format</p>
        </div>

        <div className="grid lg:grid-cols-3 gap-6">
          {/* Report List */}
          <div className="lg:col-span-1 space-y-2">
            <p className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3">Select Report</p>
            {REPORTS.map((report) => {
              const Icon = report.icon;
              const isSelected = selected?.id === report.id;
              return (
                <button
                  key={report.id}
                  onClick={() => { setSelected(report); setParams({}); }}
                  className={`w-full text-left p-3 rounded-xl border transition-all ${
                    isSelected ? "border-blue-300 bg-blue-50" : "border-gray-200 bg-white hover:border-gray-300"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-lg shrink-0 ${report.color}`}>
                      <Icon size={15} />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className={`text-sm font-bold truncate ${isSelected ? "text-blue-700" : "text-gray-800"}`}>
                          {report.title}
                        </p>
                        {!report.supported && (
                          <span className="text-[10px] bg-gray-100 text-gray-400 px-1.5 py-0.5 rounded font-medium shrink-0">
                            Soon
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-gray-400 truncate">{report.description}</p>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Report Config */}
          <div className="lg:col-span-2">
            {selected ? (
              <Card className="border-0 shadow-sm">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base font-bold">{selected.title}</CardTitle>
                  <p className="text-xs text-muted-foreground">{selected.description}</p>
                </CardHeader>
                <CardContent className="space-y-5">
                  {selected.params.length > 0 && (
                    <div>
                      <p className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3">Filters</p>
                      <div className="grid sm:grid-cols-2 gap-4">
                        {selected.params.map((p) => (
                          <div key={p.key} className="space-y-1.5">
                            <Label className="text-xs">{p.label}</Label>
                            <Input
                              type={p.type}
                              value={params[p.key] ?? ""}
                              onChange={(e) => setParams((prev) => ({ ...prev, [p.key]: e.target.value }))}
                              className="h-9 text-sm"
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div>
                    <p className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3">Export</p>
                    {!selected.supported ? (
                      <p className="text-sm text-muted-foreground italic">
                        Export for this report type is coming soon.
                      </p>
                    ) : (
                      <div className="flex flex-wrap gap-3">
                        <Button
                          onClick={() => downloadReport("csv")}
                          disabled={!!loading}
                          className="gap-2"
                        >
                          <Download size={15} />
                          {loading === "csv" ? "Downloading…" : "Download CSV"}
                        </Button>
                        <Button
                          onClick={() => downloadReport("excel")}
                          disabled={!!loading}
                          className="gap-2 bg-green-600 hover:bg-green-700"
                        >
                          <FileSpreadsheet size={15} />
                          {loading === "excel" ? "Downloading…" : "Download Excel (CSV)"}
                        </Button>
                        <Button
                          onClick={() => downloadReport("pdf")}
                          disabled={!!loading}
                          variant="outline"
                          className="gap-2 text-red-600 border-red-200 hover:bg-red-50"
                        >
                          <FileText size={15} />
                          PDF (Coming Soon)
                        </Button>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            ) : (
              <div className="h-80 flex flex-col items-center justify-center text-center rounded-xl border-2 border-dashed border-gray-200">
                <BarChart3 size={36} className="text-gray-300 mb-3" />
                <p className="text-sm font-medium text-gray-400">Select a report from the left</p>
                <p className="text-xs text-gray-300 mt-1">Configure filters and choose your export format</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </HrLayout>
  );
}
