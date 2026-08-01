import { useState, useEffect, useRef } from "react";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Textarea } from "@/components/ui/textarea";
import { useListEmployees } from "@/lib/api-client";
import { useToast } from "@/hooks/use-toast";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Play, CheckCircle, Edit, Clock, CreditCard, Layers, Download, UserCheck, Factory, Info } from "lucide-react";
import EmployeeSearchSelect from "@/components/EmployeeSearchSelect";
import { customFetch } from "@/lib/api-client/custom-fetch";
import { usePayrollGeneration } from "@/contexts/PayrollGenerationContext";
import PayrollGenerationPipeline from "@/components/PayrollGenerationPipeline";
import { exportPayrollToExcel } from "@/lib/payrollExcelExport";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTH_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// Form schema
const payrollAdjustmentSchema = z.object({
  bonus: z.string().min(1, "Bonus amount required"),
  deductions: z.string().min(1, "Deduction amount required"),
  notes: z.string().optional(),
});

export default function Salary() {
  const { toast } = useToast();
  const { data: employees } = useListEmployees({ status: "active" });

  // Filter States
  const [empFilter, setEmpFilter] = useState("all");
  const [monthFilter, setMonthFilter] = useState(String(new Date().getMonth() + 1));
  const [yearFilter, setYearFilter] = useState(String(new Date().getFullYear()));
  const [statusFilter, setStatusFilter] = useState("all");
  const [payrollGroup, setPayrollGroup] = useState<"staff" | "production">("staff");
  // Production is generated bi-weekly (1–15 / 16–end of month) — mirrors the
  // Week 1&2 / Week 3&4 split already on the Payroll page.
  const [prodWeek, setProdWeek] = useState<"week12" | "week34">("week12");

  // Data Loading States
  const [payrolls, setPayrolls] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  // Generate Payroll dialog state (separate from display filter)
  const [genMonth, setGenMonth] = useState(String(new Date().getMonth() + 1));
  const [genYear, setGenYear] = useState(String(new Date().getFullYear()));
  const [genRunType, setGenRunType] = useState<"monthly" | "biweekly">("monthly");
  const [genWeekNumber, setGenWeekNumber] = useState<1 | 2>(1);

  // Dialog open states
  const [runPayrollOpen, setRunPayrollOpen] = useState(false);
  const [adjustPayrollOpen, setAdjustPayrollOpen] = useState(false);

  // Selected state for editing
  const [selectedPayroll, setSelectedPayroll] = useState<any | null>(null);

  // Pagination
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 10;

  const payrollAdjustForm = useForm<z.infer<typeof payrollAdjustmentSchema>>({
    resolver: zodResolver(payrollAdjustmentSchema),
    defaultValues: { bonus: "0", deductions: "0", notes: "" },
  });

  const fetchPayrolls = async (overrideMonth?: string, overrideYear?: string) => {
    try {
      setLoading(true);
      const m = overrideMonth ?? monthFilter;
      const y = overrideYear ?? yearFilter;
      let url = `/api/payroll?month=${m}&year=${y}`;
      if (empFilter !== "all") url += `&employeeId=${empFilter}`;
      if (statusFilter !== "all") url += `&status=${statusFilter}`;
      const data = await customFetch<any[]>(url);
      setPayrolls(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPayrolls();
    setPage(1);
  }, [empFilter, monthFilter, yearFilter, statusFilter]);

  useEffect(() => { setPage(1); }, [payrollGroup, prodWeek]);

  // Payroll generation lives in a root-level context (PayrollGenerationProvider)
  // so it keeps running — and stays visible via the pipeline/banner — even if
  // this page unmounts mid-run, the same pattern Attendance.tsx uses for the
  // biometric sync pipeline.
  const { triggerGenerate, isGenerating, showPipeline, progress, dismiss: dismissPipeline } = usePayrollGeneration();
  const generatedParamsRef = useRef<{ month: string; year: string } | null>(null);
  const wasGeneratingRef = useRef(false);

  useEffect(() => {
    if (wasGeneratingRef.current && !isGenerating && generatedParamsRef.current) {
      const { month, year } = generatedParamsRef.current;
      fetchPayrolls(month, year);
      generatedParamsRef.current = null;
    }
    wasGeneratingRef.current = isGenerating;
  }, [isGenerating]);

  // Operations
  const handleGeneratePayroll = () => {
    if (isGenerating) {
      toast({ title: "A payroll run is already in progress", description: "Wait for it to finish before starting another." });
      return;
    }
    generatedParamsRef.current = { month: genMonth, year: genYear };
    // Always send an explicit runType — omitting it falls back to the
    // backend's "all" default, which generates staff monthly AND both
    // production bi-weekly periods together in one call. Staff is generated
    // monthly and Production is generated bi-weekly on separate schedules,
    // so they must never be forced to run together.
    triggerGenerate({
      month: Number(genMonth), year: Number(genYear),
      runType: genRunType,
      weekNumber: genRunType === "biweekly" ? genWeekNumber : undefined,
    });
    // Switch display filter/group to the generated period right away so the
    // list is pointed at the right period once results land.
    setMonthFilter(genMonth);
    setYearFilter(genYear);
    setPayrollGroup(genRunType === "monthly" ? "staff" : "production");
    if (genRunType === "biweekly") setProdWeek(genWeekNumber === 1 ? "week12" : "week34");
    setRunPayrollOpen(false);
  };

  const submitAdjustment = async (data: z.infer<typeof payrollAdjustmentSchema>) => {
    if (!selectedPayroll) return;
    try {
      await customFetch(`/api/payroll/${selectedPayroll.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          bonus: Number(data.bonus),
          deductions: Number(data.deductions),
          notes: data.notes,
        }),
      });
      toast({ title: "Adjustment applied successfully" });
      fetchPayrolls();
      setAdjustPayrollOpen(false);
    } catch (err: any) {
      toast({ title: "Adjustment failed", description: err.data?.error || "", variant: "destructive" });
    }
  };

  const markPayrollPaid = async (id: number) => {
    try {
      await customFetch(`/api/payroll/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "paid" }),
      });
      toast({ title: "Payroll status updated to Paid" });
      fetchPayrolls();
    } catch (err: any) {
      toast({ title: "Status update failed", description: err.data?.error || "", variant: "destructive" });
    }
  };

  // Staff vs Production split — staff pay is salaryMode "monthly", production is "session" (legacy) or "shift" (current)
  const isProductionMode = (mode: string) => mode === "session" || mode === "shift";
  const staffPayrolls = payrolls.filter(p => p.salaryMode === "monthly");
  const productionPayrolls = payrolls.filter(p => isProductionMode(p.salaryMode));
  const week12Payrolls = productionPayrolls.filter(p => p.weekNumber === 1);
  const week34Payrolls = productionPayrolls.filter(p => p.weekNumber === 2);
  const groupedPayrolls = payrollGroup === "staff"
    ? staffPayrolls
    : (prodWeek === "week12" ? week12Payrolls : week34Payrolls);

  // Stats calculation (reflects the selected Staff/Production/Week group)
  const totalGross = groupedPayrolls.reduce((sum, p) => sum + p.grossSalary, 0);
  const totalPaid = groupedPayrolls.filter(p => p.status === "paid").reduce((sum, p) => sum + p.finalSalary, 0);
  const totalPending = groupedPayrolls.filter(p => p.status === "pending").reduce((sum, p) => sum + p.finalSalary, 0);

  // Paginated Data
  const totalRecords = groupedPayrolls.length;
  const totalPages = Math.max(1, Math.ceil(totalRecords / PAGE_SIZE));
  const currentPage = page > totalPages ? totalPages : page;
  const paginated = groupedPayrolls.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const lastDay = new Date(Number(genYear), Number(genMonth), 0).getDate();
  const weekRange = genWeekNumber === 1
    ? `1–15 ${MONTH_SHORT[Number(genMonth) - 1]}`
    : `16–${lastDay} ${MONTH_SHORT[Number(genMonth) - 1]}`;
  const filterLastDay = new Date(Number(yearFilter), Number(monthFilter), 0).getDate();

  return (
    <HrLayout>
      <div className="flex flex-col gap-6 min-h-[calc(100vh-140px)]">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-black tracking-tight text-slate-900 flex items-center gap-2">
              <CreditCard size={28} className="text-indigo-600" />
              Salary
            </h1>
            <p className="text-muted-foreground text-sm mt-1">
              Computed payroll records — Staff handled monthly, Production handled week-wise.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            {groupedPayrolls.length > 0 && (
              <Button
                variant="outline"
                className="gap-2 border-green-600 text-green-700 hover:bg-green-50"
                onClick={() => exportPayrollToExcel(
                  groupedPayrolls,
                  payrollGroup === "staff" ? "Staff" : `Production_${prodWeek === "week12" ? "Week1-2" : "Week3-4"}`,
                  `${new Date(2000, Number(monthFilter) - 1).toLocaleDateString("en-US", { month: "long" })}_${yearFilter}`,
                )}
              >
                <Download size={16} /> Export to Excel
              </Button>
            )}
            <Button
              onClick={() => {
                setGenMonth(monthFilter);
                setGenYear(yearFilter);
                setGenRunType(payrollGroup === "staff" ? "monthly" : "biweekly");
                setGenWeekNumber(prodWeek === "week12" ? 1 : 2);
                setRunPayrollOpen(true);
              }}
              className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold transition duration-200"
            >
              <Play size={16} className="mr-2" />
              Generate Payroll
            </Button>
          </div>
        </div>

        {/* Payroll generation progress */}
        <PayrollGenerationPipeline active={showPipeline} data={progress} onDismiss={dismissPipeline} />

        {/* Global Filter Bar */}
        <Card className="shadow-sm border-slate-100 bg-white">
          <CardContent className="p-4 flex flex-wrap gap-3 items-center">
            <div className="w-56">
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1">Employee Search</label>
              <EmployeeSearchSelect
                employees={employees}
                value={empFilter}
                onChange={setEmpFilter}
                allowAll={true}
                allPlaceholder="All Employees"
                dataTestId="select-employee-filter"
              />
            </div>

            <div>
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1">Target Month</label>
              <Select value={monthFilter} onValueChange={setMonthFilter}>
                <SelectTrigger className="w-40 font-medium">
                  <SelectValue placeholder="Month" />
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: 12 }, (_, i) => (
                    <SelectItem key={i+1} value={String(i+1)}>
                      {new Date(2000, i).toLocaleDateString("en-US", { month: "long" })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1">Target Year</label>
              <Select value={yearFilter} onValueChange={setYearFilter}>
                <SelectTrigger className="w-28 font-medium">
                  <SelectValue placeholder="Year" />
                </SelectTrigger>
                <SelectContent>
                  {["2025", "2026", "2027", "2028"].map(yr => (
                    <SelectItem key={yr} value={yr}>{yr}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1">Payment Status</label>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-36 font-medium">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Payrolls</SelectItem>
                  <SelectItem value="paid">Paid</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="self-end pb-0.5">
              {(empFilter !== "all" || statusFilter !== "all" || monthFilter !== String(new Date().getMonth() + 1)) && (
                <Button variant="ghost" size="sm" onClick={() => { setEmpFilter("all"); setStatusFilter("all"); setMonthFilter(String(new Date().getMonth() + 1)); }} className="text-slate-400 hover:text-slate-600">
                  Reset Filters
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Financial Overview Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card className="border-l-4 border-l-indigo-600 bg-white shadow-sm">
            <CardContent className="p-5 flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Gross Payroll Amount</p>
                <h3 className="text-2xl font-black text-slate-900 mt-1">₹{totalGross.toLocaleString("en-IN")}</h3>
              </div>
              <div className="p-3 bg-indigo-50 text-indigo-600 rounded-xl">
                <Layers size={22} />
              </div>
            </CardContent>
          </Card>

          <Card className="border-l-4 border-l-emerald-500 bg-white shadow-sm">
            <CardContent className="p-5 flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Paid Payroll</p>
                <h3 className="text-2xl font-black text-slate-900 mt-1">₹{totalPaid.toLocaleString("en-IN")}</h3>
              </div>
              <div className="p-3 bg-emerald-50 text-emerald-600 rounded-xl">
                <CheckCircle size={22} />
              </div>
            </CardContent>
          </Card>

          <Card className="border-l-4 border-l-amber-500 bg-white shadow-sm">
            <CardContent className="p-5 flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Pending Release</p>
                <h3 className="text-2xl font-black text-slate-900 mt-1">₹{totalPending.toLocaleString("en-IN")}</h3>
              </div>
              <div className="p-3 bg-amber-50 text-amber-600 rounded-xl">
                <Clock size={22} />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Staff / Production toggle */}
        <PillTabs
          items={[
            { value: "staff", label: "Staff", count: staffPayrolls.length },
            { value: "production", label: "Production", count: productionPayrolls.length },
          ]}
          value={payrollGroup}
          onChange={(v) => setPayrollGroup(v as "staff" | "production")}
          baseColor="#0f172a"
          pillBg="#f1f5f9"
        />

        {/* Week 1&2 / Week 3&4 toggle — Production only */}
        {payrollGroup === "production" && (
          <PillTabs
            items={[
              { value: "week12", label: `Week 1 & 2 (1–15 ${MONTH_SHORT[Number(monthFilter) - 1]})`, count: week12Payrolls.length },
              { value: "week34", label: `Week 3 & 4 (16–${filterLastDay} ${MONTH_SHORT[Number(monthFilter) - 1]})`, count: week34Payrolls.length },
            ]}
            value={prodWeek}
            onChange={(v) => setProdWeek(v as "week12" | "week34")}
            baseColor="#d97706"
            pillBg="#f1f5f9"
          />
        )}

        {/* PAYROLL COMPUTATION RECORDS */}
        <div className="flex-1">
          <Card className="shadow-sm border-slate-100 bg-white">
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow className="bg-slate-50">
                    <TableHead className="pl-4 font-bold text-slate-700">Employee</TableHead>
                    <TableHead className="font-bold text-slate-700">Mode</TableHead>
                    <TableHead className="font-bold text-slate-700">Period</TableHead>
                    <TableHead className="font-bold text-slate-700">{payrollGroup === "production" ? "Shifts Worked" : "Present (Days)"}</TableHead>
                    <TableHead className="font-bold text-slate-700">Basic Rate</TableHead>
                    <TableHead className="font-bold text-slate-700">OT Pay</TableHead>
                    <TableHead className="font-bold text-slate-700">Bonus / Deduct</TableHead>
                    <TableHead className="font-bold text-slate-700">Final Payout</TableHead>
                    <TableHead className="font-bold text-slate-700">Status</TableHead>
                    <TableHead className="pr-4 text-right font-bold text-slate-700">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading && paginated.length === 0 ? (
                    Array.from({ length: 5 }).map((_, i) => (
                      <TableRow key={i}>
                        {Array.from({ length: 10 }).map((_, j) => (
                          <TableCell key={j}><Skeleton className="h-5 w-full" /></TableCell>
                        ))}
                      </TableRow>
                    ))
                  ) : paginated.length > 0 ? (
                    paginated.map((rec) => (
                      <TableRow key={rec.id} className="hover:bg-slate-50/50">
                        <TableCell className="pl-4 font-semibold text-slate-900">
                          <div>{rec.employeeName}</div>
                          <span className="text-[10px] text-slate-400 block font-mono">ID: {rec.employeeId}</span>
                        </TableCell>
                        <TableCell className="text-xs font-semibold">
                          <Badge variant="outline" className={rec.salaryMode === "monthly" ? "text-blue-700 bg-blue-50 border-blue-100" : "text-purple-700 bg-purple-50 border-purple-100"}>
                            {rec.salaryMode === "monthly" ? "Monthly" : rec.salaryMode === "shift" ? "Shift" : "Session"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs font-medium text-slate-600">
                          {rec.month}/{rec.year}{rec.weekNumber ? ` · Wk ${rec.weekNumber}` : ""}
                        </TableCell>
                        <TableCell className="text-xs font-mono font-medium text-slate-700">
                          {isProductionMode(rec.salaryMode) ? `${rec.presentDays} Shifts` : `${rec.presentDays} Days`}
                        </TableCell>
                        <TableCell className="font-medium text-xs">₹{rec.baseSalary.toLocaleString("en-IN")}</TableCell>
                        <TableCell className="font-medium text-xs text-indigo-600">₹{rec.otAmount.toLocaleString("en-IN")}</TableCell>
                        <TableCell className="text-xs">
                          <span className="text-emerald-600 font-semibold">+₹{rec.bonus}</span>
                          <span className="text-rose-600 font-semibold ml-2">-₹{rec.deductions}</span>
                        </TableCell>
                        <TableCell className="font-black text-indigo-700 text-sm">₹{rec.finalSalary.toLocaleString("en-IN")}</TableCell>
                        <TableCell>
                          <Badge className={rec.status === "paid" ? "bg-emerald-100 text-emerald-800 border-transparent font-bold hover:bg-emerald-200" : "bg-amber-100 text-amber-800 border-transparent font-bold hover:bg-amber-200"}>
                            {rec.status.toUpperCase()}
                          </Badge>
                        </TableCell>
                        <TableCell className="pr-4 text-right flex gap-1 justify-end">
                          <Button size="icon" variant="ghost" className="h-8 w-8 text-indigo-600 hover:text-indigo-800" onClick={() => {
                            setSelectedPayroll(rec);
                            payrollAdjustForm.setValue("bonus", String(rec.bonus));
                            payrollAdjustForm.setValue("deductions", String(rec.deductions));
                            payrollAdjustForm.setValue("notes", rec.notes || "");
                            setAdjustPayrollOpen(true);
                          }}>
                            <Edit size={14} />
                          </Button>
                          {rec.status === "pending" && (
                            <Button size="sm" variant="ghost" className="h-8 text-emerald-600 hover:text-emerald-800 hover:bg-emerald-50 px-2" onClick={() => markPayrollPaid(rec.id)}>
                              <CheckCircle size={13} className="mr-1" /> Pay
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))
                  ) : (
                    <TableRow>
                      <TableCell colSpan={10} className="text-center py-16 text-muted-foreground">
                        No payroll computations generated for this period. Click "Generate Payroll" to run the wage engine.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>

        {/* BOTTOM PAGINATION ELEMENT (Kept fixed at page end) */}
        {totalRecords > PAGE_SIZE && (
          <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between border-t bg-card rounded-lg shadow-sm shrink-0 mt-auto">
            <p className="text-sm text-muted-foreground font-medium">
              Showing {paginated.length} of {totalRecords} entries
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={currentPage === 1}
                onClick={() => setPage(currentPage - 1)}
              >
                Previous
              </Button>
              <span className="text-xs font-semibold text-slate-700 bg-slate-100 px-3 py-1.5 rounded-md font-mono">
                Page {currentPage} of {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={currentPage === totalPages}
                onClick={() => setPage(currentPage + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* DIALOG: GENERATE PAYROLL — Staff/Production + Week aware, mirrors PayrollFull.tsx's
          Generate dialog so this page can never fall back to generating everything at once. */}
      <Dialog open={runPayrollOpen} onOpenChange={setRunPayrollOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Play size={16} className="text-indigo-600" />
              Generate Payroll
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">

            {/* Run type selector */}
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setGenRunType("monthly")}
                className={`p-3 rounded-lg border-2 text-left transition-all ${genRunType === "monthly" ? "border-indigo-600 bg-indigo-50" : "border-gray-200 hover:border-gray-300"}`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <UserCheck size={14} className={genRunType === "monthly" ? "text-indigo-700" : "text-gray-500"} />
                  <span className={`font-semibold text-sm ${genRunType === "monthly" ? "text-indigo-800" : "text-gray-700"}`}>Staff Monthly</span>
                </div>
                <p className="text-xs text-muted-foreground">Pro-rated monthly salary for all staff</p>
              </button>
              <button
                onClick={() => setGenRunType("biweekly")}
                className={`p-3 rounded-lg border-2 text-left transition-all ${genRunType === "biweekly" ? "border-amber-500 bg-amber-50" : "border-gray-200 hover:border-gray-300"}`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <Factory size={14} className={genRunType === "biweekly" ? "text-amber-700" : "text-gray-500"} />
                  <span className={`font-semibold text-sm ${genRunType === "biweekly" ? "text-amber-800" : "text-gray-700"}`}>Production Bi-Weekly</span>
                </div>
                <p className="text-xs text-muted-foreground">Shift-based pay for production</p>
              </button>
            </div>

            {/* Period selection */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Month</Label>
                <select value={genMonth} onChange={e => setGenMonth(e.target.value)} className="w-full h-9 rounded-md border px-3 text-sm bg-background">
                  {MONTH_NAMES.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Year</Label>
                <Input type="number" value={genYear} onChange={e => setGenYear(e.target.value)} className="h-9" min={2020} max={2030} />
              </div>
            </div>

            {/* Week selector for biweekly */}
            {genRunType === "biweekly" && (
              <div className="space-y-2">
                <Label className="text-xs">Pay Period</Label>
                <div className="grid grid-cols-2 gap-2">
                  {([
                    { wk: 1 as const, label: "Week 1 & 2", range: `1–15 ${MONTH_SHORT[Number(genMonth) - 1]}` },
                    { wk: 2 as const, label: "Week 3 & 4", range: `16–${lastDay} ${MONTH_SHORT[Number(genMonth) - 1]}` },
                  ]).map(({ wk, label, range }) => (
                    <button
                      key={wk}
                      onClick={() => setGenWeekNumber(wk)}
                      className={`p-2.5 rounded-lg border-2 text-center transition-all ${genWeekNumber === wk ? "border-amber-500 bg-amber-50" : "border-gray-200 hover:border-amber-200"}`}
                    >
                      <p className={`font-bold text-sm ${genWeekNumber === wk ? "text-amber-800" : "text-gray-700"}`}>{label}</p>
                      <p className="text-xs text-muted-foreground">{range}</p>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Summary box */}
            <div className={`rounded-lg p-3 flex items-start gap-2 ${genRunType === "monthly" ? "bg-indigo-50 border border-indigo-100" : "bg-amber-50 border border-amber-100"}`}>
              <Info size={14} className={`${genRunType === "monthly" ? "text-indigo-600" : "text-amber-600"} mt-0.5 shrink-0`} />
              <p className={`text-xs ${genRunType === "monthly" ? "text-indigo-800" : "text-amber-800"}`}>
                {genRunType === "monthly"
                  ? `Will generate monthly payroll for all active staff employees for ${MONTH_NAMES[Number(genMonth) - 1]} ${genYear}. Calculations are based on attendance logs, approved leave, and advances.`
                  : `Will generate shift-based payroll for all active production employees for ${weekRange} (${genWeekNumber === 1 ? "Week 1 & 2" : "Week 3 & 4"}). Pay = total shifts earned × salary per shift.`
                }
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRunPayrollOpen(false)}>Cancel</Button>
            <Button
              onClick={handleGeneratePayroll} disabled={isGenerating}
              className={genRunType === "monthly" ? "bg-indigo-600 hover:bg-indigo-700 text-white font-bold" : "bg-amber-600 hover:bg-amber-700 text-white font-bold"}
            >
              {isGenerating ? "A run is already in progress…" : (
                <><Play size={13} className="mr-1.5" />Generate {genRunType === "monthly" ? "Staff" : "Production"} Payroll</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* DIALOG: ADJUST PAYROLL */}
      <Dialog open={adjustPayrollOpen} onOpenChange={setAdjustPayrollOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Adjust Employee Payroll</DialogTitle>
          </DialogHeader>
          <Form {...payrollAdjustForm}>
            <form onSubmit={payrollAdjustForm.handleSubmit(submitAdjustment)} className="space-y-4">
              <div className="bg-slate-50 p-3 rounded-lg border text-xs mb-2">
                <strong>Employee:</strong> {selectedPayroll?.employeeName} <br />
                <strong>Base Wage:</strong> ₹{selectedPayroll?.baseSalary} <br />
                <strong>OT Wage:</strong> ₹{selectedPayroll?.otAmount}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <FormField control={payrollAdjustForm.control} name="bonus" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Bonus (₹)</FormLabel>
                    <FormControl><Input type="number" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={payrollAdjustForm.control} name="deductions" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Deductions (₹)</FormLabel>
                    <FormControl><Input type="number" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>

              <FormField control={payrollAdjustForm.control} name="notes" render={({ field }) => (
                <FormItem>
                  <FormLabel>Notes / Adjustments justification</FormLabel>
                  <FormControl><Textarea rows={2} {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setAdjustPayrollOpen(false)}>Cancel</Button>
                <Button type="submit" className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold">Apply Changes</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </HrLayout>
  );
}
