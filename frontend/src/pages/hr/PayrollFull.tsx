import { useState } from "react";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  useListPayrollRuns, useGeneratePayroll,
  getListPayrollRunsQueryKey, PayrollRunItem,
} from "@/lib/api-client";
import { useQueryClient } from "@tanstack/react-query";
import {
  IndianRupee, Play, Lock, CheckCircle2, Clock, Users,
  TrendingUp, Download, Plus, AlertCircle,
} from "lucide-react";

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

const STATUS_CONFIG: Record<string, { label: string; cls: string }> = {
  draft:      { label: "Draft",      cls: "bg-gray-50 text-gray-700 border-gray-200" },
  processing: { label: "Processing", cls: "bg-blue-50 text-blue-700 border-blue-200" },
  approved:   { label: "Approved",   cls: "bg-green-50 text-green-700 border-green-200" },
  locked:     { label: "Locked",     cls: "bg-purple-50 text-purple-700 border-purple-200" },
};

function RunCard({ run }: { run: PayrollRunItem }) {
  const s = STATUS_CONFIG[run.status] ?? STATUS_CONFIG.draft;
  return (
    <Card className="border hover:shadow-sm transition-shadow">
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <h4 className="font-bold text-sm text-gray-900">
                {MONTH_NAMES[(run.month ?? 1) - 1]} {run.year} — {run.salaryMode === "monthly" ? "Monthly" : "Bi-Weekly"}
              </h4>
              <Badge className={`text-xs border ${s.cls}`}>{s.label}</Badge>
              {run.weekNumber && <Badge variant="outline" className="text-xs">Week {run.weekNumber}</Badge>}
            </div>
            <p className="text-xs text-gray-500 mb-3">
              Employee: {run.employeeName ?? `#${run.employeeId}`}
            </p>
            <div className="grid grid-cols-3 gap-4">
              {[
                { label: "Gross",  value: `₹${(run.grossSalary / 1000).toFixed(1)}K`,  color: "text-blue-700" },
                { label: "Deduct", value: `₹${(run.deductions / 1000).toFixed(1)}K`,   color: "text-red-600" },
                { label: "Net",    value: `₹${(run.finalSalary / 1000).toFixed(1)}K`,  color: "text-green-700" },
              ].map(({ label, value, color }) => (
                <div key={label}>
                  <p className="text-xs text-gray-400">{label}</p>
                  <p className={`text-sm font-bold ${color}`}>{value}</p>
                </div>
              ))}
            </div>
            {run.notes && (
              <p className="text-xs text-gray-400 mt-2 italic">{run.notes}</p>
            )}
          </div>
          <div className="flex flex-col gap-2 items-end">
            {run.status === "locked" && (
              <span className="flex items-center gap-1 text-xs text-purple-600">
                <Lock size={11} /> Locked
              </span>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function PayrollFull() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [showGenerate, setShowGenerate] = useState(false);
  const [genForm, setGenForm] = useState({
    month: new Date().getMonth() + 1,
    year: new Date().getFullYear(),
  });
  const [filterMonth, setFilterMonth] = useState<number | undefined>(undefined);
  const [filterYear, setFilterYear] = useState<number | undefined>(undefined);

  const { data: runs, isLoading } = useListPayrollRuns({
    month: filterMonth,
    year: filterYear,
  });

  const generateMutation = useGeneratePayroll();

  const generatePayroll = async () => {
    let result: { message: string } | null = null;
    try {
      result = await generateMutation.mutateAsync(genForm);
    } catch {
      toast({ title: "Failed to generate payroll", variant: "destructive" });
      return;
    }
    toast({ title: result!.message });
    setShowGenerate(false);
    queryClient.invalidateQueries({ queryKey: getListPayrollRunsQueryKey() });
  };

  const totalGross = (runs ?? []).reduce((s, r) => s + r.grossSalary, 0);
  const totalDeductions = (runs ?? []).reduce((s, r) => s + r.deductions, 0);
  const totalNet = (runs ?? []).reduce((s, r) => s + r.finalSalary, 0);

  return (
    <HrLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-black text-gray-900">Payroll</h2>
            <p className="text-muted-foreground text-sm mt-0.5">Generate and manage payroll for staff and production employees</p>
          </div>
          <Button className="gap-2" onClick={() => setShowGenerate(s => !s)}>
            <Plus size={15} /> Generate Payroll
          </Button>
        </div>

        {showGenerate && (
          <Card className="border-2 border-blue-200 bg-blue-50/30">
            <CardContent className="p-5">
              <h3 className="font-bold text-sm text-gray-800 mb-4">Generate Payroll</h3>
              <p className="text-xs text-gray-500 mb-4">
                This will generate payroll records for all active employees for the selected month/year based on attendance data.
              </p>
              <div className="grid sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-gray-600">Month</label>
                  <select value={genForm.month}
                    onChange={e => setGenForm(f => ({ ...f, month: Number(e.target.value) }))}
                    className="w-full h-9 rounded-md border px-3 text-sm bg-white">
                    {MONTH_NAMES.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-gray-600">Year</label>
                  <Input type="number" value={genForm.year}
                    onChange={e => setGenForm(f => ({ ...f, year: Number(e.target.value) }))}
                    className="bg-white" min={2020} max={2030} />
                </div>
              </div>
              <div className="flex gap-2 mt-4">
                <Button size="sm" onClick={generatePayroll} disabled={generateMutation.isPending}>
                  <Play size={13} className="mr-1" />
                  {generateMutation.isPending ? "Generating…" : "Run Payroll"}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setShowGenerate(false)}>Cancel</Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Filter */}
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-xs font-medium text-gray-500">Filter:</span>
          <select value={filterMonth ?? ""}
            onChange={e => setFilterMonth(e.target.value ? Number(e.target.value) : undefined)}
            className="h-8 rounded-md border px-3 text-sm bg-background">
            <option value="">All Months</option>
            {MONTH_NAMES.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
          </select>
          <Input type="number" value={filterYear ?? ""}
            onChange={e => setFilterYear(e.target.value ? Number(e.target.value) : undefined)}
            placeholder="Year" className="h-8 w-24 text-sm" />
        </div>

        {/* Summary Cards */}
        {!isLoading && (runs ?? []).length > 0 && (
          <div className="grid grid-cols-3 gap-4">
            {[
              { label: "Total Gross", value: `₹${(totalGross / 100000).toFixed(1)}L`, color: "text-blue-700", icon: TrendingUp },
              { label: "Total Deductions", value: `₹${(totalDeductions / 1000).toFixed(0)}K`, color: "text-red-600", icon: IndianRupee },
              { label: "Total Net Pay", value: `₹${(totalNet / 100000).toFixed(1)}L`, color: "text-green-700", icon: CheckCircle2 },
            ].map(s => (
              <Card key={s.label} className="border-0 shadow-sm">
                <CardContent className="p-4">
                  <p className="text-xs text-muted-foreground font-medium">{s.label}</p>
                  <p className={`text-xl font-black mt-0.5 ${s.color}`}>{s.value}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Payroll Records */}
        <div className="space-y-3">
          {isLoading ? (
            Array.from({ length: 3 }).map((_, i) => (
              <Card key={i} className="border-0 shadow-sm">
                <CardContent className="p-5">
                  <Skeleton className="h-5 w-48 mb-2" />
                  <Skeleton className="h-4 w-64 mb-3" />
                  <div className="grid grid-cols-3 gap-4">
                    <Skeleton className="h-8 w-full" />
                    <Skeleton className="h-8 w-full" />
                    <Skeleton className="h-8 w-full" />
                  </div>
                </CardContent>
              </Card>
            ))
          ) : (runs ?? []).length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <Users size={32} className="mx-auto text-gray-200 mb-3" />
              <p className="text-sm">No payroll records found.</p>
              <p className="text-xs text-gray-400 mt-1">Use "Generate Payroll" to compute payroll from attendance data.</p>
            </div>
          ) : (
            (runs ?? []).map(run => <RunCard key={run.id} run={run} />)
          )}
        </div>

        <Card className="border-0 bg-gray-50">
          <CardContent className="p-4">
            <div className="flex items-start gap-2">
              <AlertCircle size={14} className="text-blue-500 mt-0.5 shrink-0" />
              <div className="text-xs text-gray-500">
                <strong>Payroll Rules:</strong> Staff employees are paid <strong>monthly</strong>. Production employees are paid <strong>bi-weekly (every 2 weeks)</strong>.
                PF = 12% of Basic. ESI applies to employees earning ≤ ₹21,000/month.
                Advances and loans are auto-deducted per the repayment schedule.
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </HrLayout>
  );
}
