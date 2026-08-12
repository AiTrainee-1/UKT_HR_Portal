import { useState } from "react";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { usePayrollGeneration } from "@/contexts/PayrollGenerationContext";
import { useSalarySlipBulk } from "@/contexts/SalarySlipBulkContext";
import PayrollGenerationPipeline from "@/components/PayrollGenerationPipeline";
import SalarySlipBulkPipeline from "@/components/SalarySlipBulkPipeline";
import { MONTH_NAMES, STATUS_CONFIG, BreakdownDrawer, PayrollRow } from "@/components/payroll/BreakdownDrawer";
import {
  useListDepartments, useUpdatePayrollRecord, useListSalarySlips,
  useEmailSalarySlip, type SalarySlipItem,
} from "@/lib/api-client";
import { previewDocumentPdf, downloadDocumentPdf } from "@/lib/api-client/custom-hooks";
import {
  useProductionNextPeriod, useProductionSkipCheck, useListProductionPayroll,
  usePayrollSettings, type ProductionPayrollItem,
} from "@/lib/api-client/custom-hooks";
import { useQueryClient } from "@tanstack/react-query";
import { exportPayrollToExcel } from "@/lib/payrollExcelExport";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Factory, Play, Users, TrendingUp, IndianRupee, CheckCircle2, Clock,
  AlertCircle, Info, AlertTriangle, RefreshCcw, X, Search, Download,
  CalendarClock, Mail, FileSearch, Layers, Loader2, Edit, SlidersHorizontal,
} from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
//  Skipped Employees preview (production-scoped)
// ─────────────────────────────────────────────────────────────────────────────

function ProductionSkippedDialog({ periodStart, periodEnd, onClose }: {
  periodStart: string; periodEnd: string; onClose: () => void;
}) {
  const { data, isLoading, isFetching, refetch } = useProductionSkipCheck({ periodStart, periodEnd });

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle size={16} className="text-amber-600" /> Skipped Employees
          </DialogTitle>
          <p className="text-xs text-muted-foreground">Production · {periodStart} – {periodEnd}</p>
        </DialogHeader>

        {isLoading ? (
          <div className="space-y-2 py-4">
            {[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}
          </div>
        ) : !data || data.skipped.length === 0 ? (
          <div className="py-10 text-center text-muted-foreground">
            <CheckCircle2 size={28} className="mx-auto mb-2 text-green-300" />
            <p className="text-sm font-semibold text-gray-700">Nobody would be skipped</p>
            <p className="text-xs mt-0.5">All {data?.totalChecked ?? 0} active production employees checked out fine for this period.</p>
          </div>
        ) : (
          <div className="space-y-3 py-2">
            <p className="text-xs text-gray-500">
              {data.skippedCount} of {data.totalChecked} active employees would be skipped if you generated now:
            </p>
            <div className="space-y-2 max-h-80 overflow-y-auto">
              {data.skipped.map(s => (
                <div key={s.employeeId} className="rounded-lg border border-amber-100 bg-amber-50/60 px-3 py-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-sm text-amber-900">{s.name}</span>
                    <span className="text-xs text-amber-600 font-mono">{s.employeeCode}</span>
                  </div>
                  <p className="text-xs text-amber-700 mt-0.5">{s.reason}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCcw size={12} className={isFetching ? "animate-spin" : ""} /> Re-check
          </Button>
          <Button onClick={onClose}><X size={14} className="mr-1" />Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Generate dialog -next due period by default, optional backfill
// ─────────────────────────────────────────────────────────────────────────────

const PERIOD_FREQUENCY_LABELS: Record<string, string> = {
  weekly: "Weekly", "2weeks": "2 Weeks", "3weeks": "3 Weeks", monthly: "Monthly",
};
const PERIOD_STYLE_LABELS: Record<string, string> = {
  calendar_month: "Calendar Month Anchored", weekday_anchored: "Weekday Anchored", custom_recurring: "Custom Recurring",
};

function GenerateProductionDialog({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const { toast } = useToast();
  const { triggerGenerateProduction, isGenerating } = usePayrollGeneration();
  const { data: nextPeriod, isLoading } = useProductionNextPeriod();
  const { data: ps } = usePayrollSettings();
  const [backfill, setBackfill] = useState(false);
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");

  const effectiveStart = backfill ? periodStart : nextPeriod?.periodStart;
  const effectiveEnd = backfill ? periodEnd : nextPeriod?.periodEnd;
  const periodHasEnded = backfill
    ? !!(periodStart && periodEnd && new Date(periodEnd) <= new Date())
    : !!nextPeriod?.periodEnded;

  const handleGenerate = () => {
    if (isGenerating) {
      toast({ title: "A payroll run is already in progress", description: "Wait for it to finish before starting another." });
      return;
    }
    if (!effectiveStart || !effectiveEnd) return;
    triggerGenerateProduction(backfill ? { periodStart, periodEnd } : undefined);
    onSuccess();
    onClose();
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Play size={16} className="text-amber-600" /> Generate Production Payroll
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          {/* Settings-in-effect summary -so there's no confusion about which
              saved configuration this run will apply, before generating. */}
          {ps && (
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 space-y-1.5">
              <p className="text-xs font-bold text-gray-600 flex items-center gap-1.5">
                <SlidersHorizontal size={12} /> Configuration in effect
              </p>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-gray-700">
                <span className="text-gray-400">Period</span>
                <span className="font-medium">
                  {PERIOD_FREQUENCY_LABELS[ps.prodPeriodFrequency] ?? ps.prodPeriodFrequency} · {PERIOD_STYLE_LABELS[ps.prodPeriodStyle] ?? ps.prodPeriodStyle}
                </span>
                <span className="text-gray-400">Attendance Mode</span>
                <span className="font-medium capitalize">{ps.prodAttendanceMode}</span>
                <span className="text-gray-400">Late Detection</span>
                <span className="font-medium">
                  {ps.prodLateDetectionEnabled ? (
                    <>Enabled · {ps.prodLateFreeAllowance ?? 0} free · {(ps.prodLateDeductionSlabs ?? []).length} slab{(ps.prodLateDeductionSlabs ?? []).length === 1 ? "" : "s"}</>
                  ) : "Disabled"}
                </span>
              </div>
              <p className="text-[11px] text-gray-400">
                Change these in Settings → Payroll → Production Payroll.
              </p>
            </div>
          )}

          {isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : !backfill ? (
            <div className="rounded-lg border-2 border-amber-500 bg-amber-50 p-3">
              <p className="text-xs text-amber-700 font-medium">Next period to generate</p>
              <p className="text-lg font-black text-amber-900">{nextPeriod?.periodStart} – {nextPeriod?.periodEnd}</p>
              <p className="text-xs text-amber-700 mt-1">
                {nextPeriod?.periodEnded
                  ? "This period has ended -ready to generate."
                  : "This period hasn't ended yet -come back once it has."}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Period Start</Label>
                <Input type="date" value={periodStart} onChange={e => setPeriodStart(e.target.value)} className="h-9" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Period End</Label>
                <Input type="date" value={periodEnd} onChange={e => setPeriodEnd(e.target.value)} className="h-9" />
              </div>
            </div>
          )}

          <button
            className="text-xs text-blue-600 hover:underline"
            onClick={() => setBackfill(b => !b)}
          >
            {backfill ? "← Use the next due period instead" : "Backfill a specific past period instead →"}
          </button>

          <div className="rounded-lg p-3 flex items-start gap-2 bg-amber-50 border border-amber-100">
            <Info size={14} className="text-amber-600 mt-0.5 shrink-0" />
            <p className="text-xs text-amber-800">
              Pay = total shifts earned × salary per shift, computed from punch-time coverage of the
              period configured in Settings → Payroll → Production. No leave/permission -Sunday is a
              normal working day unless the shift configuration says otherwise.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            onClick={handleGenerate}
            disabled={isGenerating || !effectiveStart || !effectiveEnd || !periodHasEnded}
            className="bg-amber-600 hover:bg-amber-700"
          >
            {isGenerating ? "A run is already in progress…" : <><Play size={13} className="mr-1.5" />Generate</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Payroll sub-tab -generate + run list, mirrors PayrollFull.tsx
// ─────────────────────────────────────────────────────────────────────────────

function PayrollSubTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [showGenerate, setShowGenerate] = useState(false);
  const [showSkipCheck, setShowSkipCheck] = useState(false);
  const [breakdownId, setBreakdownId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [deptFilter, setDeptFilter] = useState("all");

  const updateMutation = useUpdatePayrollRecord();
  const { showPipeline, progress, dismiss: dismissPipeline } = usePayrollGeneration();
  const { data: departments } = useListDepartments();
  const { data: nextPeriod } = useProductionNextPeriod();
  const { data: runs, isLoading } = useListProductionPayroll({ limit: 500 });

  const allRuns = runs ?? [];
  const filteredRuns = allRuns.filter(r => {
    if (deptFilter !== "all" && String(r.departmentId ?? "") !== deptFilter) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return r.employeeName?.toLowerCase().includes(q) || r.employeeCode?.toLowerCase().includes(q);
  });

  const totalGross = filteredRuns.reduce((s, r) => s + r.grossSalary, 0);
  const totalDeductions = filteredRuns.reduce((s, r) => s + r.deductions, 0);
  const totalNet = filteredRuns.reduce((s, r) => s + r.finalSalary, 0);
  const pendingCount = filteredRuns.filter(r => r.status === "pending").length;

  const handleMarkPaid = async (run: { id: number; employeeName?: string | null }) => {
    try {
      await updateMutation.mutateAsync({ id: run.id, data: { status: "paid" } });
      toast({ title: `${run.employeeName ?? "Employee"}'s salary marked as paid` });
      queryClient.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === "string" && q.queryKey[0].startsWith("/api/payroll") });
    } catch {
      toast({ title: "Failed to update status", variant: "destructive" });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
          <CalendarClock size={13} />
          {nextPeriod
            ? <>Next period: <strong className="text-gray-700">{nextPeriod.periodStart} – {nextPeriod.periodEnd}</strong>{!nextPeriod.periodEnded && " (not ended yet)"}</>
            : "Loading next period…"}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline" className="gap-2 h-9 border-amber-200 text-amber-700 hover:bg-amber-50"
            onClick={() => setShowSkipCheck(true)}
            disabled={!nextPeriod}
          >
            <AlertTriangle size={14} /> Skipped Employees
          </Button>
          <Button className="gap-2 h-9 bg-amber-600 hover:bg-amber-700" onClick={() => setShowGenerate(true)}>
            <Play size={14} /> Generate Payroll
          </Button>
        </div>
      </div>

      <PayrollGenerationPipeline active={showPipeline} data={progress} onDismiss={dismissPipeline} />

      {showGenerate && (
        <GenerateProductionDialog
          onClose={() => setShowGenerate(false)}
          onSuccess={() => queryClient.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === "string" && q.queryKey[0].startsWith("/api/payroll") })}
        />
      )}
      {showSkipCheck && nextPeriod && (
        <ProductionSkippedDialog
          periodStart={nextPeriod.periodStart}
          periodEnd={nextPeriod.periodEnd}
          onClose={() => setShowSkipCheck(false)}
        />
      )}

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by employee code or name…"
            value={search} onChange={e => setSearch(e.target.value)}
            className="h-8 pl-8 text-sm w-56"
          />
        </div>
        <Select value={deptFilter} onValueChange={setDeptFilter}>
          <SelectTrigger className="h-8 w-44 text-sm"><SelectValue placeholder="Department" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Departments</SelectItem>
            {departments?.map(d => <SelectItem key={d.id} value={String(d.id)}>{d.name}</SelectItem>)}
          </SelectContent>
        </Select>
        {filteredRuns.length > 0 && (
          <Button
            variant="outline" size="sm" className="gap-2 h-8 border-green-600 text-green-700 hover:bg-green-50 ml-auto"
            onClick={() => exportPayrollToExcel(filteredRuns, "Production", "all_periods")}
          >
            <Download size={13} /> Export to Excel
          </Button>
        )}
      </div>

      {!isLoading && filteredRuns.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: "Total Gross", value: `₹${(totalGross / 1000).toFixed(1)}K`, color: "text-blue-700", icon: TrendingUp, bg: "bg-blue-50" },
            { label: "Deductions", value: `₹${(totalDeductions / 1000).toFixed(1)}K`, color: "text-red-600", icon: IndianRupee, bg: "bg-red-50" },
            { label: "Net Payable", value: `₹${(totalNet / 1000).toFixed(1)}K`, color: "text-green-700", icon: CheckCircle2, bg: "bg-green-50" },
            { label: "Pending Payment", value: `${pendingCount} employees`, color: "text-amber-700", icon: Clock, bg: "bg-amber-50" },
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

      <div className="space-y-2">
        {isLoading ? (
          Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-16 w-full rounded-xl" />)
        ) : filteredRuns.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground border-2 border-dashed border-gray-200 rounded-xl">
            <Users size={32} className="mx-auto text-gray-200 mb-3" />
            <p className="text-sm font-semibold text-gray-600">No production payroll records yet</p>
            <p className="text-xs text-gray-400 mt-1">Click "Generate Payroll" to compute payroll from attendance data.</p>
            <Button className="mt-4 gap-2 bg-amber-600 hover:bg-amber-700" onClick={() => setShowGenerate(true)}>
              <Play size={14} /> Generate Payroll
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {filteredRuns.map(run => (
              <PayrollRow key={run.id} run={run} onViewBreakdown={setBreakdownId} onMarkPaid={handleMarkPaid} />
            ))}
          </div>
        )}
      </div>

      <Card className="border-0 bg-gray-50">
        <CardContent className="p-4">
          <div className="flex items-start gap-2">
            <AlertCircle size={14} className="text-amber-500 mt-0.5 shrink-0" />
            <div className="text-xs text-gray-500 space-y-0.5">
              <p><strong>Production:</strong> Pay = total shifts earned × salary per shift, computed from punch-time coverage of the shift segments configured in Settings → Payroll.</p>
              <p><strong>Period & frequency</strong> are configured in Settings → Payroll → Production. Changing them takes effect from the next period generated onward.</p>
              <p><strong>Advances</strong> are auto-deducted from the monthly repayment schedule configured in the Advances module.</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {breakdownId && <BreakdownDrawer payrollId={breakdownId} onClose={() => setBreakdownId(null)} />}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Salary sub-tab -per-employee table with bonus/deduction adjustment
// ─────────────────────────────────────────────────────────────────────────────

const payrollAdjustmentSchema = z.object({
  bonus: z.string().min(1, "Bonus amount required"),
  deductions: z.string().min(1, "Deduction amount required"),
  notes: z.string().optional(),
});

const SALARY_PAGE_SIZE = 10;

function SalarySubTab() {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [selected, setSelected] = useState<ProductionPayrollItem | null>(null);
  const { data: runs, isLoading } = useListProductionPayroll({ limit: 500, status: statusFilter === "all" ? undefined : statusFilter });
  const updateMutation = useUpdatePayrollRecord();

  const adjustForm = useForm<z.infer<typeof payrollAdjustmentSchema>>({
    resolver: zodResolver(payrollAdjustmentSchema),
    defaultValues: { bonus: "0", deductions: "0", notes: "" },
  });

  const filtered = (runs ?? []).filter(r => {
    if (!search) return true;
    const q = search.toLowerCase();
    return r.employeeName?.toLowerCase().includes(q) || r.employeeCode?.toLowerCase().includes(q);
  });

  const totalGross = filtered.reduce((sum, r) => sum + r.grossSalary, 0);
  const totalPaid = filtered.filter(r => r.status === "paid").reduce((sum, r) => sum + r.finalSalary, 0);
  const totalPending = filtered.filter(r => r.status === "pending").reduce((sum, r) => sum + r.finalSalary, 0);

  const totalPages = Math.max(1, Math.ceil(filtered.length / SALARY_PAGE_SIZE));
  const currentPage = page > totalPages ? totalPages : page;
  const paginated = filtered.slice((currentPage - 1) * SALARY_PAGE_SIZE, currentPage * SALARY_PAGE_SIZE);

  const markPaid = async (id: number, name: string | null | undefined) => {
    try {
      await updateMutation.mutateAsync({ id, data: { status: "paid" } });
      toast({ title: `${name ?? "Employee"}'s salary marked as paid` });
    } catch {
      toast({ title: "Failed to update status", variant: "destructive" });
    }
  };

  const openAdjust = (r: ProductionPayrollItem) => {
    setSelected(r);
    adjustForm.reset({ bonus: String(r.bonus), deductions: String(r.deductions), notes: r.notes ?? "" });
    setAdjustOpen(true);
  };

  const submitAdjustment = async (data: z.infer<typeof payrollAdjustmentSchema>) => {
    if (!selected) return;
    try {
      await updateMutation.mutateAsync({
        id: selected.id,
        data: { bonus: Number(data.bonus), deductions: Number(data.deductions), notes: data.notes },
      });
      toast({ title: "Adjustment applied successfully" });
      setAdjustOpen(false);
    } catch {
      toast({ title: "Adjustment failed", variant: "destructive" });
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="Search employee…" value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} className="h-8 pl-8 text-sm w-56" />
        </div>
        <Select value={statusFilter} onValueChange={v => { setStatusFilter(v); setPage(1); }}>
          <SelectTrigger className="h-8 w-36 text-sm"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="paid">Paid</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Financial overview cards -mirrors Staff Salary page */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="border-l-4 border-l-indigo-600 bg-white shadow-sm">
          <CardContent className="p-5 flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Gross Payroll Amount</p>
              <h3 className="text-2xl font-black text-slate-900 mt-1">₹{totalGross.toLocaleString("en-IN", { maximumFractionDigits: 0 })}</h3>
            </div>
            <div className="p-3 bg-indigo-50 text-indigo-600 rounded-xl"><Layers size={22} /></div>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-emerald-500 bg-white shadow-sm">
          <CardContent className="p-5 flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Paid Payroll</p>
              <h3 className="text-2xl font-black text-slate-900 mt-1">₹{totalPaid.toLocaleString("en-IN", { maximumFractionDigits: 0 })}</h3>
            </div>
            <div className="p-3 bg-emerald-50 text-emerald-600 rounded-xl"><CheckCircle2 size={22} /></div>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-amber-500 bg-white shadow-sm">
          <CardContent className="p-5 flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Pending Release</p>
              <h3 className="text-2xl font-black text-slate-900 mt-1">₹{totalPending.toLocaleString("en-IN", { maximumFractionDigits: 0 })}</h3>
            </div>
            <div className="p-3 bg-amber-50 text-amber-600 rounded-xl"><Clock size={22} /></div>
          </CardContent>
        </Card>
      </div>

      <div className="rounded-xl border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left px-3 py-2 font-semibold text-gray-600">Employee</th>
              <th className="text-left px-3 py-2 font-semibold text-gray-600">Period</th>
              <th className="text-left px-3 py-2 font-semibold text-gray-600">Shifts</th>
              <th className="text-left px-3 py-2 font-semibold text-gray-600">Gross</th>
              <th className="text-left px-3 py-2 font-semibold text-gray-600">Bonus / Deduct</th>
              <th className="text-left px-3 py-2 font-semibold text-gray-600">Net</th>
              <th className="text-left px-3 py-2 font-semibold text-gray-600">Status</th>
              <th className="text-right px-3 py-2 font-semibold text-gray-600">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}><td colSpan={8} className="px-3 py-2"><Skeleton className="h-6 w-full" /></td></tr>
              ))
            ) : paginated.length === 0 ? (
              <tr><td colSpan={8} className="text-center py-10 text-muted-foreground text-xs">No production salary records for this filter.</td></tr>
            ) : paginated.map(r => {
              const s = STATUS_CONFIG[r.status] ?? STATUS_CONFIG.pending;
              return (
                <tr key={r.id} className="hover:bg-gray-50/50">
                  <td className="px-3 py-2">
                    <p className="font-semibold text-gray-900">{r.employeeName ?? r.employeeCode}</p>
                    <p className="text-xs text-muted-foreground font-mono">{r.employeeCode}</p>
                  </td>
                  <td className="px-3 py-2 text-xs">{r.periodStart} – {r.periodEnd}</td>
                  <td className="px-3 py-2">{r.presentDays}</td>
                  <td className="px-3 py-2">₹{r.grossSalary.toLocaleString("en-IN", { maximumFractionDigits: 0 })}</td>
                  <td className="px-3 py-2 text-xs">
                    <span className="text-emerald-600 font-semibold">+₹{r.bonus}</span>
                    <span className="text-rose-600 font-semibold ml-2">-₹{r.deductions}</span>
                  </td>
                  <td className="px-3 py-2 font-bold text-green-700">₹{r.finalSalary.toLocaleString("en-IN", { maximumFractionDigits: 0 })}</td>
                  <td className="px-3 py-2"><Badge className={`text-xs border ${s.cls}`}>{s.label}</Badge></td>
                  <td className="px-3 py-2 text-right">
                    <div className="inline-flex items-center gap-1">
                      <Button size="icon" variant="ghost" className="h-7 w-7 text-indigo-600 hover:text-indigo-800" onClick={() => openAdjust(r)}>
                        <Edit size={13} />
                      </Button>
                      {r.status === "pending" && (
                        <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => markPaid(r.id, r.employeeName)}>
                          <CheckCircle2 size={11} /> Mark Paid
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {filtered.length > SALARY_PAGE_SIZE && (
        <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between border-t bg-card rounded-lg shadow-sm">
          <p className="text-sm text-muted-foreground font-medium">
            Showing {paginated.length} of {filtered.length} entries
          </p>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>Previous</Button>
            <span className="text-xs font-semibold text-slate-700 bg-slate-100 px-3 py-1.5 rounded-md font-mono">
              Page {currentPage} of {totalPages}
            </span>
            <Button variant="outline" size="sm" disabled={currentPage === totalPages} onClick={() => setPage(currentPage + 1)}>Next</Button>
          </div>
        </div>
      )}

      {/* Adjust Payroll dialog -bonus/deductions/notes, mirrors Staff Salary page */}
      <Dialog open={adjustOpen} onOpenChange={setAdjustOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Adjust Employee Payroll</DialogTitle></DialogHeader>
          <Form {...adjustForm}>
            <form onSubmit={adjustForm.handleSubmit(submitAdjustment)} className="space-y-4">
              <div className="bg-slate-50 p-3 rounded-lg border text-xs mb-2">
                <strong>Employee:</strong> {selected?.employeeName} <br />
                <strong>Period:</strong> {selected?.periodStart} – {selected?.periodEnd} <br />
                <strong>Gross Salary:</strong> ₹{selected?.grossSalary}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <FormField control={adjustForm.control} name="bonus" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Bonus (₹)</FormLabel>
                    <FormControl><Input type="number" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={adjustForm.control} name="deductions" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Deductions (₹)</FormLabel>
                    <FormControl><Input type="number" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>
              <FormField control={adjustForm.control} name="notes" render={({ field }) => (
                <FormItem>
                  <FormLabel>Notes / Adjustments justification</FormLabel>
                  <FormControl><Textarea rows={2} {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setAdjustOpen(false)}>Cancel</Button>
                <Button type="submit" className="bg-amber-600 hover:bg-amber-700">Apply Changes</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Payslip sub-tab -reuses the Salary Slip PDF pipeline, scoped to Production
// ─────────────────────────────────────────────────────────────────────────────

function PayslipSubTab() {
  const { toast } = useToast();
  const { token } = useAuth();
  const emailMutation = useEmailSalarySlip();
  const today = new Date();
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [year, setYear] = useState(today.getFullYear());
  const [search, setSearch] = useState("");
  const [emailing, setEmailing] = useState<number | null>(null);
  const [pdfBusy, setPdfBusy] = useState<{ id: number; mode: "preview" | "download" } | null>(null);
  const { isRunning: bulkRunning, showPipeline, progress, dismiss: dismissBulkPipeline, triggerBulkDownload, triggerBulkEmail } = useSalarySlipBulk();

  const { data: slips = [], isLoading } = useListSalarySlips({ month, year, employmentType: "production" });

  const filtered = slips.filter(s => {
    if (!search) return true;
    const q = search.toLowerCase();
    return s.employeeName.toLowerCase().includes(q) || s.employeeCode.toLowerCase().includes(q);
  });

  // Month overview -based on the full month's set (not the search box),
  // mirrors the Staff Salary Slip page exactly.
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

  async function doEmail(slip: SalarySlipItem) {
    setEmailing(slip.id);
    try {
      const result = await emailMutation.mutateAsync({ id: slip.id });
      toast({ title: `Email sent to ${slip.employeeName}`, description: `Salary slip delivered to ${result.sentTo}` });
    } catch (err: any) {
      toast({ title: "Failed to send email", description: err?.message ?? "Unknown error", variant: "destructive" });
    } finally {
      setEmailing(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3 flex-wrap">
          <select value={month} onChange={e => setMonth(Number(e.target.value))} className="h-8 rounded-md border px-3 text-sm bg-background">
            {MONTH_NAMES.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
          </select>
          <Input type="number" value={year} onChange={e => setYear(Number(e.target.value))} className="h-8 w-20 text-sm" min={2020} max={2030} />
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Search employee…" value={search} onChange={e => setSearch(e.target.value)} className="h-8 pl-8 text-sm w-56" />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline" size="sm" className="gap-2 h-8 border-purple-200 text-purple-700 hover:bg-purple-50"
            disabled={bulkRunning || slips.length === 0}
            onClick={() => triggerBulkEmail({ month, year, employmentType: "production" })}
          >
            {bulkRunning && progress?.kind === "email" ? <Loader2 size={13} className="animate-spin" /> : <Mail size={13} />}
            Bulk Send ({slips.length})
          </Button>
          <Button
            variant="outline" size="sm" className="gap-2 h-8"
            disabled={bulkRunning || slips.length === 0}
            onClick={() => triggerBulkDownload({ month, year, employmentType: "production" })}
          >
            {bulkRunning && progress?.kind === "pdf" ? <Loader2 size={13} className="animate-spin" /> : <Layers size={13} />}
            Bulk Download ({slips.length})
          </Button>
        </div>
      </div>

      <SalarySlipBulkPipeline active={showPipeline} data={progress} onDismiss={dismissBulkPipeline} />

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

      <div className="rounded-xl border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left px-3 py-2 font-semibold text-gray-600">Employee</th>
              <th className="text-left px-3 py-2 font-semibold text-gray-600">Net Salary</th>
              <th className="text-right px-3 py-2 font-semibold text-gray-600">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}><td colSpan={3} className="px-3 py-2"><Skeleton className="h-6 w-full" /></td></tr>
              ))
            ) : filtered.length === 0 ? (
              <tr><td colSpan={3} className="text-center py-10 text-muted-foreground text-xs">No production payslips for {MONTH_NAMES[month - 1]} {year}.</td></tr>
            ) : filtered.map(s => (
              <tr key={s.id} className="hover:bg-gray-50/50">
                <td className="px-3 py-2">
                  <p className="font-semibold text-gray-900">{s.employeeName}</p>
                  <p className="text-xs text-muted-foreground font-mono">{s.employeeCode}</p>
                </td>
                <td className="px-3 py-2 font-bold text-green-700">₹{s.netSalary.toLocaleString("en-IN", { maximumFractionDigits: 0 })}</td>
                <td className="px-3 py-2 text-right">
                  <div className="inline-flex items-center gap-1">
                    <Button size="icon" variant="ghost" className="h-7 w-7" disabled={pdfBusy?.id === s.id} onClick={() => doPdf(s, "preview")}>
                      <FileSearch size={13} />
                    </Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7" disabled={pdfBusy?.id === s.id} onClick={() => doPdf(s, "download")}>
                      <Download size={13} />
                    </Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7" disabled={emailing === s.id} onClick={() => doEmail(s)}>
                      <Mail size={13} />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Main Page
// ─────────────────────────────────────────────────────────────────────────────

export default function ProductionPayroll() {
  const [tab, setTab] = useState<"payroll" | "salary" | "payslip">("payroll");

  return (
    <HrLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h2 className="text-2xl font-black text-gray-900 flex items-center gap-2">
              <Factory size={22} className="text-amber-600" /> Production Payroll
            </h2>
            <p className="text-muted-foreground text-sm mt-0.5">
              Shift-based payroll for production employees, on its own configurable period cycle.
            </p>
          </div>
        </div>

        <PillTabs
          items={[
            { value: "payroll", label: "Payroll" },
            { value: "salary", label: "Salary" },
            { value: "payslip", label: "Payslip" },
          ]}
          value={tab}
          onChange={(v) => setTab(v as typeof tab)}
          baseColor="#d97706"
        />

        <Separator />

        {tab === "payroll" && <PayrollSubTab />}
        {tab === "salary" && <SalarySubTab />}
        {tab === "payslip" && <PayslipSubTab />}
      </div>
    </HrLayout>
  );
}
