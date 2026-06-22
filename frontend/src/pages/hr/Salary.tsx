import { useState, useEffect } from "react";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Textarea } from "@/components/ui/textarea";
import { useListEmployees } from "@/lib/api-client";
import { useToast } from "@/hooks/use-toast";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Plus, CheckCircle, Cpu, FileSpreadsheet, UploadCloud, RefreshCw, Edit, Trash, Settings, Clock, CreditCard, Layers } from "lucide-react";
import EmployeeSearchSelect from "@/components/EmployeeSearchSelect";
import Loader from "@/components/Loader";
import { customFetch } from "@/lib/api-client/custom-fetch";

// Form schemas
const manualPunchSchema = z.object({
  employeeId: z.string().min(1, "Employee is required"),
  date: z.string().min(1, "Date is required"),
  punchTime: z.string().min(1, "Time is required"),
  punchType: z.enum(["IN", "OUT"]),
});

const payrollAdjustmentSchema = z.object({
  bonus: z.string().min(1, "Bonus amount required"),
  deductions: z.string().min(1, "Deduction amount required"),
  notes: z.string().optional(),
});

const sessionConfigSchema = z.object({
  name: z.string().min(1, "Session Name required"),
  startTime: z.string().min(1, "Start Time required"),
  endTime: z.string().min(1, "End Time required"),
  payAmount: z.string().min(1, "Pay amount required"),
  isOvertime: z.boolean().default(false),
  order: z.string().min(1, "Order required"),
});

export default function Salary() {
  const { toast } = useToast();
  const { data: employees } = useListEmployees({});
  
  // Tabs
  const [activeTab, setActiveTab] = useState<"payroll" | "punches" | "sessions" | "configs">("payroll");

  // Filter States
  const [empFilter, setEmpFilter] = useState("all");
  const [monthFilter, setMonthFilter] = useState(String(new Date().getMonth() + 1));
  const [yearFilter, setYearFilter] = useState(String(new Date().getFullYear()));
  const [statusFilter, setStatusFilter] = useState("all");

  // Data Loading States
  const [payrolls, setPayrolls] = useState<any[]>([]);
  const [punches, setPunches] = useState<any[]>([]);
  const [sessions, setSessions] = useState<any[]>([]);
  const [configs, setConfigs] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  // Dialog open states
  const [runPayrollOpen, setRunPayrollOpen] = useState(false);
  const [runProcessOpen, setRunProcessOpen] = useState(false);
  const [manualPunchOpen, setManualPunchOpen] = useState(false);
  const [adjustPayrollOpen, setAdjustPayrollOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  
  // Selected state for editing
  const [selectedPayroll, setSelectedPayroll] = useState<any | null>(null);
  const [selectedConfig, setSelectedConfig] = useState<any | null>(null);

  // File Upload State
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  // Pagination
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 10;

  // Forms
  const manualPunchForm = useForm<z.infer<typeof manualPunchSchema>>({
    resolver: zodResolver(manualPunchSchema),
    defaultValues: { punchType: "IN" },
  });

  const payrollAdjustForm = useForm<z.infer<typeof payrollAdjustmentSchema>>({
    resolver: zodResolver(payrollAdjustmentSchema),
    defaultValues: { bonus: "0", deductions: "0", notes: "" },
  });

  const sessionConfigForm = useForm<z.infer<typeof sessionConfigSchema>>({
    resolver: zodResolver(sessionConfigSchema),
    defaultValues: { name: "", startTime: "08:30", endTime: "11:00", payAmount: "150", isOvertime: false, order: "1" },
  });

  // Fetch functions using customFetch
  const fetchPayrolls = async () => {
    try {
      setLoading(true);
      let url = `/api/payroll?month=${monthFilter}&year=${yearFilter}`;
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

  const fetchPunches = async () => {
    try {
      setLoading(true);
      let url = `/api/attendance-logs?month=${monthFilter}&year=${yearFilter}`;
      if (empFilter !== "all") url += `&employeeId=${empFilter}`;
      const data = await customFetch<any[]>(url);
      setPunches(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const fetchSessions = async () => {
    try {
      setLoading(true);
      let url = `/api/work-sessions?month=${monthFilter}&year=${yearFilter}`;
      if (empFilter !== "all") url += `&employeeId=${empFilter}`;
      const data = await customFetch<any[]>(url);
      setSessions(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const fetchConfigs = async () => {
    try {
      const data = await customFetch<any[]>("/api/session-configs");
      setConfigs(data);
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    if (activeTab === "payroll") fetchPayrolls();
    if (activeTab === "punches") fetchPunches();
    if (activeTab === "sessions") fetchSessions();
    if (activeTab === "configs") fetchConfigs();
    setPage(1);
  }, [activeTab, empFilter, monthFilter, yearFilter, statusFilter]);

  // Operations
  const handleGeneratePayroll = async () => {
    try {
      setLoading(true);
      const res = await customFetch<any>("/api/payroll/generate", {
        method: "POST",
        body: JSON.stringify({ month: Number(monthFilter), year: Number(yearFilter) }),
      });
      toast({
        title: "Success",
        description: res.message || "Payroll generated successfully.",
      });
      fetchPayrolls();
      setRunPayrollOpen(false);
    } catch (err: any) {
      toast({
        title: "Error",
        description: err.data?.error || "Failed to generate payroll.",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleProcessSessions = async () => {
    try {
      setLoading(true);
      const res = await customFetch<any>("/api/attendance-logs/process-sessions", {
        method: "POST",
        body: JSON.stringify({ month: Number(monthFilter), year: Number(yearFilter) }),
      });
      toast({
        title: "Success",
        description: res.message || "Punch sessions paired and processed successfully.",
      });
      fetchSessions();
      setRunProcessOpen(false);
    } catch (err: any) {
      toast({
        title: "Error",
        description: err.data?.error || "Failed to process logs.",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleExcelUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!uploadFile) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", uploadFile);

      // Fetch base options for customFetch with multipart body
      const response = await fetch(`${window.location.origin}/api/attendance-logs/upload-excel`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${localStorage.getItem("uk_textile_token")}`,
        },
        body: formData,
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Failed to upload excel file");
      }

      const res = await response.json();
      toast({
        title: "Excel Upload Complete",
        description: res.message || "Attendance punches imported successfully.",
      });
      fetchPunches();
      setUploadFile(null);
    } catch (err: any) {
      toast({
        title: "Excel Import Failed",
        description: err.message || "Excel template parsing failed.",
        variant: "destructive",
      });
    } finally {
      setUploading(false);
    }
  };

  const submitManualPunch = async (data: z.infer<typeof manualPunchSchema>) => {
    try {
      await customFetch("/api/attendance-logs", {
        method: "POST",
        body: JSON.stringify({
          employeeId: Number(data.employeeId),
          date: data.date,
          punchTime: data.punchTime,
          punchType: data.punchType,
        }),
      });
      toast({ title: "Punch log added" });
      fetchPunches();
      setManualPunchOpen(false);
      manualPunchForm.reset();
    } catch (err: any) {
      toast({ title: "Failed to add log", description: err.data?.error || "", variant: "destructive" });
    }
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

  const submitSessionConfig = async (data: z.infer<typeof sessionConfigSchema>) => {
    try {
      if (selectedConfig) {
        // Edit mode
        await customFetch(`/api/session-configs/${selectedConfig.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            name: data.name,
            startTime: data.startTime,
            endTime: data.endTime,
            payAmount: Number(data.payAmount),
            isOvertime: data.isOvertime,
            order: Number(data.order),
          }),
        });
        toast({ title: "Session configuration updated" });
      } else {
        // Add mode
        await customFetch("/api/session-configs", {
          method: "POST",
          body: JSON.stringify({
            name: data.name,
            startTime: data.startTime,
            endTime: data.endTime,
            payAmount: Number(data.payAmount),
            isOvertime: data.isOvertime,
            order: Number(data.order),
          }),
        });
        toast({ title: "Session configuration created" });
      }
      fetchConfigs();
      setConfigOpen(false);
      setSelectedConfig(null);
    } catch (err: any) {
      toast({ title: "Operation failed", description: err.data?.error || "", variant: "destructive" });
    }
  };

  const deleteConfig = async (id: number) => {
    if (!confirm("Are you sure you want to delete this session config?")) return;
    try {
      await customFetch(`/api/session-configs/${id}`, { method: "DELETE" });
      toast({ title: "Configuration deleted" });
      fetchConfigs();
    } catch (err: any) {
      toast({ title: "Delete failed", description: err.data?.error || "", variant: "destructive" });
    }
  };

  // Stats calculation
  const totalGross = payrolls.reduce((sum, p) => sum + p.grossSalary, 0);
  const totalPaid = payrolls.filter(p => p.status === "paid").reduce((sum, p) => sum + p.finalSalary, 0);
  const totalPending = payrolls.filter(p => p.status === "pending").reduce((sum, p) => sum + p.finalSalary, 0);
  
  // Paginated Data
  const getPaginatedData = () => {
    let dataList: any[] = [];
    if (activeTab === "payroll") dataList = payrolls;
    else if (activeTab === "punches") dataList = punches;
    else if (activeTab === "sessions") dataList = sessions;
    else if (activeTab === "configs") dataList = configs;

    const totalRecords = dataList.length;
    const totalPages = Math.max(1, Math.ceil(totalRecords / PAGE_SIZE));
    
    // Safety check on page limits
    const currentPage = page > totalPages ? totalPages : page;

    return {
      paginated: dataList.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
      totalRecords,
      totalPages,
      currentPage,
    };
  };

  const { paginated, totalRecords, totalPages, currentPage } = getPaginatedData();

  return (
    <HrLayout>
      <div className="flex flex-col gap-6 min-h-[calc(100vh-140px)]">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-black tracking-tight text-slate-900 flex items-center gap-2">
              <CreditCard size={28} className="text-indigo-600" />
              Enterprise Payroll Dashboard
            </h1>
            <p className="text-muted-foreground text-sm mt-1">
              Garment Industry Payroll processing including raw biometric logs, paired session rates, and weekly/monthly worker payroll.
            </p>
          </div>
          
          <div className="flex flex-wrap gap-2">
            {activeTab === "payroll" && (
              <Button onClick={() => setRunPayrollOpen(true)} className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold transition duration-200">
                <Cpu size={16} className="mr-2 animate-pulse" />
                Generate Period Payroll
              </Button>
            )}
            {activeTab === "punches" && (
              <Button onClick={() => setManualPunchOpen(true)} variant="outline" className="border-indigo-200 hover:bg-indigo-50">
                <Plus size={16} className="mr-2" /> Manual Punch Log
              </Button>
            )}
            {activeTab === "sessions" && (
              <Button onClick={() => setRunProcessOpen(true)} className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold transition duration-200">
                <RefreshCw size={16} className="mr-2 animate-spin-slow" />
                Pair & Process Sessions
              </Button>
            )}
            {activeTab === "configs" && (
              <Button onClick={() => { setSelectedConfig(null); sessionConfigForm.reset(); setConfigOpen(true); }} className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold">
                <Plus size={16} className="mr-2" /> Add Session Rate
              </Button>
            )}
          </div>
        </div>

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

            {activeTab === "payroll" && (
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
            )}

            <div className="self-end pb-0.5">
              {(empFilter !== "all" || statusFilter !== "all" || monthFilter !== String(new Date().getMonth() + 1)) && (
                <Button variant="ghost" size="sm" onClick={() => { setEmpFilter("all"); setStatusFilter("all"); setMonthFilter(String(new Date().getMonth() + 1)); }} className="text-slate-400 hover:text-slate-600">
                  Reset Filters
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Dynamic Financial Overview Cards (Only on Payroll Tab) */}
        {activeTab === "payroll" && (
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
        )}

        {/* Tab Navigation */}
        <div className="flex border-b border-slate-200">
          <button
            onClick={() => setActiveTab("payroll")}
            className={`py-3 px-6 font-bold text-sm tracking-wide transition border-b-2 -mb-[2px] ${
              activeTab === "payroll"
                ? "border-indigo-600 text-indigo-600 font-extrabold"
                : "border-transparent text-slate-500 hover:text-slate-700"
            }`}
          >
            📊 Payroll Computed Records
          </button>
          <button
            onClick={() => setActiveTab("punches")}
            className={`py-3 px-6 font-bold text-sm tracking-wide transition border-b-2 -mb-[2px] ${
              activeTab === "punches"
                ? "border-indigo-600 text-indigo-600 font-extrabold"
                : "border-transparent text-slate-500 hover:text-slate-700"
            }`}
          >
            📥 Biometric Raw Punches
          </button>
          <button
            onClick={() => setActiveTab("sessions")}
            className={`py-3 px-6 font-bold text-sm tracking-wide transition border-b-2 -mb-[2px] ${
              activeTab === "sessions"
                ? "border-indigo-600 text-indigo-600 font-extrabold"
                : "border-transparent text-slate-500 hover:text-slate-700"
            }`}
          >
            ⚙️ Paired Work Sessions
          </button>
          <button
            onClick={() => setActiveTab("configs")}
            className={`py-3 px-6 font-bold text-sm tracking-wide transition border-b-2 -mb-[2px] ${
              activeTab === "configs"
                ? "border-indigo-600 text-indigo-600 font-extrabold"
                : "border-transparent text-slate-500 hover:text-slate-700"
            }`}
          >
            🛠️ Session configurations
          </button>
        </div>

        {/* MAIN DATA PANELS */}
        <div className="flex-1">
          {/* TAB 1: PAYROLL COMPUTATION RECORDS */}
          {activeTab === "payroll" && (
            <Card className="shadow-sm border-slate-100 bg-white">
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-slate-50">
                      <TableHead className="pl-4 font-bold text-slate-700">Employee</TableHead>
                      <TableHead className="font-bold text-slate-700">Mode</TableHead>
                      <TableHead className="font-bold text-slate-700">Period</TableHead>
                      <TableHead className="font-bold text-slate-700">Present (Days)</TableHead>
                      <TableHead className="font-bold text-slate-700 font-mono">Sessions</TableHead>
                      <TableHead className="font-bold text-slate-700">Basic Rate</TableHead>
                      <TableHead className="font-bold text-slate-700">OT Pay</TableHead>
                      <TableHead className="font-bold text-slate-700">Bonus / Deduct</TableHead>
                      <TableHead className="font-bold text-slate-700">Final Payout</TableHead>
                      <TableHead className="font-bold text-slate-700">Status</TableHead>
                      <TableHead className="pr-4 text-right font-bold text-slate-700">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {loading ? (
                      Array.from({ length: 5 }).map((_, i) => (
                        <TableRow key={i}>
                          {Array.from({ length: 11 }).map((_, j) => (
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
                          <TableCell className="capitalize text-xs font-semibold">
                            <Badge variant="outline" className={rec.salaryMode === "monthly" ? "text-blue-700 bg-blue-50 border-blue-100" : "text-purple-700 bg-purple-50 border-purple-100"}>
                              {rec.salaryMode}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs font-medium text-slate-600">{rec.month}/{rec.year}</TableCell>
                          <TableCell className="text-xs font-mono font-medium text-slate-700">{rec.presentDays} Days</TableCell>
                          <TableCell className="text-xs font-mono font-medium text-slate-700">{rec.completedSessions} shifts</TableCell>
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
                        <TableCell colSpan={11} className="text-center py-16 text-muted-foreground">
                          No payroll computations generated for this month. Click "Generate Period Payroll" to run the wage engine.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          {/* TAB 2: BIOMETRIC RAW PUNCHES */}
          {activeTab === "punches" && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                {/* Excel Import Card */}
                <Card className="lg:col-span-1 border-slate-100 bg-white shadow-sm">
                  <CardHeader className="pb-3"><CardTitle className="text-base font-bold text-slate-800">Import Biometric Sheets</CardTitle></CardHeader>
                  <CardContent>
                    <form onSubmit={handleExcelUpload} className="space-y-4">
                      <div className="border-2 border-dashed border-slate-200 hover:border-indigo-400 transition rounded-xl p-6 text-center bg-slate-50/50 cursor-pointer relative">
                        <input
                          type="file"
                          accept=".xlsx, .xls"
                          onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
                          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                        />
                        <div className="flex flex-col items-center gap-2">
                          <UploadCloud size={32} className="text-indigo-500" />
                          <span className="text-xs font-bold text-slate-700">
                            {uploadFile ? uploadFile.name : "Drag Excel or Click to Browse"}
                          </span>
                          <span className="text-[10px] text-slate-400">Supports standard IN/OUT punch lists</span>
                        </div>
                      </div>
                      
                      <div className="text-[11px] bg-indigo-50 text-indigo-700 p-2.5 rounded-lg border border-indigo-100">
                        <strong>Expected Columns:</strong> Employee ID, Employee Name, Date, Time, Type (IN/OUT)
                      </div>

                      <Button type="submit" disabled={!uploadFile || uploading} className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold transition">
                        {uploading ? "Importing punch lists..." : "Import punches from Excel"}
                      </Button>
                    </form>
                  </CardContent>
                </Card>

                {/* Raw Punches Logs list */}
                <Card className="lg:col-span-2 border-slate-100 bg-white shadow-sm">
                  <CardHeader className="pb-3"><CardTitle className="text-base font-bold text-slate-800">Biometric Logs History</CardTitle></CardHeader>
                  <CardContent className="p-0">
                    <Table>
                      <TableHeader>
                        <TableRow className="bg-slate-50">
                          <TableHead className="pl-4 font-bold text-slate-600">Employee ID</TableHead>
                          <TableHead className="font-bold text-slate-600">Punch Date</TableHead>
                          <TableHead className="font-bold text-slate-600">Punch Time</TableHead>
                          <TableHead className="font-bold text-slate-600">Punch Type</TableHead>
                          <TableHead className="pr-4 text-right font-bold text-slate-600">Source</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {loading ? (
                          Array.from({ length: 5 }).map((_, i) => (
                            <TableRow key={i}>
                              {Array.from({ length: 5 }).map((_, j) => (
                                <TableCell key={j}><Skeleton className="h-5 w-full" /></TableCell>
                              ))}
                            </TableRow>
                          ))
                        ) : paginated.length > 0 ? (
                          paginated.map((log) => {
                            const emp = employees?.find(e => e.id === log.employeeId);
                            const name = emp ? `${emp.firstName} ${emp.lastName}` : `ID: ${log.employeeId}`;
                            return (
                              <TableRow key={log.id} className="hover:bg-slate-50/50">
                                <TableCell className="pl-4 font-semibold text-slate-900">
                                  <div>{name}</div>
                                  <span className="text-[10px] text-slate-400 font-mono">CODE: {emp?.employeeCode || "N/A"}</span>
                                </TableCell>
                                <TableCell className="text-xs font-mono font-medium text-slate-600">{log.date}</TableCell>
                                <TableCell className="text-xs font-mono font-black text-indigo-700">{log.punchTime}</TableCell>
                                <TableCell>
                                  <Badge className={log.punchType === "IN" ? "bg-blue-100 text-blue-800 hover:bg-blue-200" : "bg-rose-100 text-rose-800 hover:bg-rose-200"}>
                                    {log.punchType}
                                  </Badge>
                                </TableCell>
                                <TableCell className="pr-4 text-right capitalize text-xs text-slate-400">{log.source}</TableCell>
                              </TableRow>
                            );
                          })
                        ) : (
                          <TableRow>
                            <TableCell colSpan={5} className="text-center py-16 text-muted-foreground">
                              No raw biometric punch logs found. Try importing from an Excel sheet.
                            </TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              </div>
            </div>
          )}

          {/* TAB 3: PAIRED WORK SESSIONS */}
          {activeTab === "sessions" && (
            <Card className="shadow-sm border-slate-100 bg-white">
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-slate-50">
                      <TableHead className="pl-4 font-bold text-slate-700">Employee</TableHead>
                      <TableHead className="font-bold text-slate-700">Date</TableHead>
                      <TableHead className="font-bold text-slate-700">Session Name</TableHead>
                      <TableHead className="font-bold text-slate-700">Check In</TableHead>
                      <TableHead className="font-bold text-slate-700">Check Out</TableHead>
                      <TableHead className="font-bold text-slate-700">Hours Worked</TableHead>
                      <TableHead className="font-bold text-slate-700">Computed Pay</TableHead>
                      <TableHead className="font-bold text-slate-700">Overtime?</TableHead>
                      <TableHead className="pr-4 text-right font-bold text-slate-700">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {loading ? (
                      Array.from({ length: 5 }).map((_, i) => (
                        <TableRow key={i}>
                          {Array.from({ length: 9 }).map((_, j) => (
                            <TableCell key={j}><Skeleton className="h-5 w-full" /></TableCell>
                          ))}
                        </TableRow>
                      ))
                    ) : paginated.length > 0 ? (
                      paginated.map((ws) => (
                        <TableRow key={ws.id} className="hover:bg-slate-50/50">
                          <TableCell className="pl-4 font-semibold text-slate-900">{ws.employeeName}</TableCell>
                          <TableCell className="text-xs font-mono">{ws.date}</TableCell>
                          <TableCell className="font-medium text-xs text-indigo-700 capitalize">{ws.sessionName} Shift</TableCell>
                          <TableCell className="text-xs font-mono text-slate-600">{ws.checkIn}</TableCell>
                          <TableCell className="text-xs font-mono text-slate-600">{ws.checkOut}</TableCell>
                          <TableCell className="font-mono text-xs font-semibold text-slate-700">{ws.hoursWorked} hrs</TableCell>
                          <TableCell className="font-bold text-sm text-slate-900">₹{ws.sessionAmount.toLocaleString("en-IN")}</TableCell>
                          <TableCell>
                            {ws.isOvertime ? (
                              <Badge className="bg-purple-100 text-purple-800 border-transparent font-bold">OT</Badge>
                            ) : (
                              <span className="text-xs text-slate-400">—</span>
                            )}
                          </TableCell>
                          <TableCell className="pr-4 text-right">
                            <Button size="icon" variant="ghost" className="h-8 w-8 text-rose-600 hover:text-rose-800 hover:bg-rose-50" onClick={async () => {
                              if (confirm("Delete this processed work session?")) {
                                await customFetch(`/work-sessions/${ws.id}`, { method: "DELETE" });
                                toast({ title: "Work Session deleted" });
                                fetchSessions();
                              }
                            }}>
                              <Trash size={14} />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))
                    ) : (
                      <TableRow>
                        <TableCell colSpan={9} className="text-center py-16 text-muted-foreground">
                          No paired work sessions found. Click "Pair & Process Sessions" to group IN/OUT logs into wage-calculable shifts.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          {/* TAB 4: SESSION CONFIGURATION */}
          {activeTab === "configs" && (
            <Card className="shadow-sm border-slate-100 bg-white">
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-slate-50">
                      <TableHead className="pl-4 font-bold text-slate-700">Display Order</TableHead>
                      <TableHead className="font-bold text-slate-700">Session Name</TableHead>
                      <TableHead className="font-bold text-slate-700">Shift Hours</TableHead>
                      <TableHead className="font-bold text-slate-700">Standard Payout Rate</TableHead>
                      <TableHead className="font-bold text-slate-700">Overtime Premium?</TableHead>
                      <TableHead className="pr-4 text-right font-bold text-slate-700">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paginated.length > 0 ? (
                      paginated.map((cfg) => (
                        <TableRow key={cfg.id} className="hover:bg-slate-50/50">
                          <TableCell className="pl-4 font-mono font-medium">{cfg.order}</TableCell>
                          <TableCell className="font-semibold text-slate-900">{cfg.name} Session</TableCell>
                          <TableCell className="text-xs font-mono font-semibold flex items-center gap-1.5 mt-2.5">
                            <Clock size={12} className="text-slate-400" />
                            {cfg.startTime} – {cfg.endTime}
                          </TableCell>
                          <TableCell className="font-bold text-indigo-700">₹{cfg.payAmount} per shift</TableCell>
                          <TableCell>
                            {cfg.isOvertime ? (
                              <Badge className="bg-purple-100 text-purple-800 border-transparent font-bold">YES</Badge>
                            ) : (
                              <Badge variant="outline" className="text-slate-400 border-slate-200">NO</Badge>
                            )}
                          </TableCell>
                          <TableCell className="pr-4 text-right flex gap-1 justify-end">
                            <Button size="icon" variant="ghost" className="h-8 w-8 text-indigo-600 hover:text-indigo-800" onClick={() => {
                              setSelectedConfig(cfg);
                              sessionConfigForm.setValue("name", cfg.name);
                              sessionConfigForm.setValue("startTime", cfg.startTime);
                              sessionConfigForm.setValue("endTime", cfg.endTime);
                              sessionConfigForm.setValue("payAmount", String(cfg.payAmount));
                              sessionConfigForm.setValue("isOvertime", cfg.isOvertime);
                              sessionConfigForm.setValue("order", String(cfg.order));
                              setConfigOpen(true);
                            }}>
                              <Edit size={14} />
                            </Button>
                            <Button size="icon" variant="ghost" className="h-8 w-8 text-rose-600 hover:text-rose-800" onClick={() => deleteConfig(cfg.id)}>
                              <Trash size={14} />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))
                    ) : (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center py-16 text-muted-foreground">
                          No custom session configurations defined.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
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

      {/* DIALOG 1: GENERATE PERIOD PAYROLL */}
      <Dialog open={runPayrollOpen} onOpenChange={setRunPayrollOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Cpu className="text-indigo-600" size={20} />
              Automated Payroll Processing
            </DialogTitle>
          </DialogHeader>
          <div className="py-4 space-y-3">
            <p className="text-sm text-slate-500">
              Run calculations for all active employees for <strong>{new Date(2000, Number(monthFilter)-1).toLocaleDateString("en-US", { month: "long" })} {yearFilter}</strong>.
            </p>
            <div className="bg-slate-50 p-3 rounded-lg border text-xs text-slate-600 space-y-1.5">
              <div>• <strong>Monthly Staff:</strong> Pro-rated salary = (Base / 26) * present days</div>
              <div>• <strong>Contract Workers:</strong> Sum of completed shift rates + OT premium</div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRunPayrollOpen(false)}>Cancel</Button>
            <Button onClick={handleGeneratePayroll} className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold">
              Execute Payroll Engine
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* DIALOG 2: PAIR & PROCESS SESSIONS */}
      <Dialog open={runProcessOpen} onOpenChange={setRunProcessOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RefreshCw className="text-indigo-600 animate-spin-slow" size={20} />
              Session Processor Engine
            </DialogTitle>
          </DialogHeader>
          <div className="py-4 space-y-3">
            <p className="text-sm text-slate-500">
              Process biometric raw punches for <strong>{new Date(2000, Number(monthFilter)-1).toLocaleDateString("en-US", { month: "long" })} {yearFilter}</strong>.
            </p>
            <p className="text-xs text-amber-600 font-semibold bg-amber-50 p-2.5 rounded-md border border-amber-100">
              Warning: This will group raw IN/OUT punch pairs into standard work shifts, calculate session rates, and overwrite any manual session logs for this month.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRunProcessOpen(false)}>Cancel</Button>
            <Button onClick={handleProcessSessions} className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold">
              Pair IN/OUT Logs
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* DIALOG 3: MANUAL PUNCH LOG */}
      <Dialog open={manualPunchOpen} onOpenChange={setManualPunchOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Manual Punch Correction</DialogTitle></DialogHeader>
          <Form {...manualPunchForm}>
            <form onSubmit={manualPunchForm.handleSubmit(submitManualPunch)} className="space-y-4">
              <FormField control={manualPunchForm.control} name="employeeId" render={({ field }) => (
                <FormItem className="flex flex-col">
                  <FormLabel>Employee</FormLabel>
                  <FormControl>
                    <EmployeeSearchSelect
                      employees={employees}
                      value={field.value}
                      onChange={field.onChange}
                      placeholder="Select employee"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              
              <div className="grid grid-cols-2 gap-3">
                <FormField control={manualPunchForm.control} name="date" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Date</FormLabel>
                    <FormControl><Input type="date" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={manualPunchForm.control} name="punchTime" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Time (HH:MM)</FormLabel>
                    <FormControl><Input type="time" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>

              <FormField control={manualPunchForm.control} name="punchType" render={({ field }) => (
                <FormItem>
                  <FormLabel>Punch Type</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                    <SelectContent>
                      <SelectItem value="IN">IN Punch</SelectItem>
                      <SelectItem value="OUT">OUT Punch</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setManualPunchOpen(false)}>Cancel</Button>
                <Button type="submit" className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold">Save Punch</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* DIALOG 4: ADJUST PAYROLL */}
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

      {/* DIALOG 5: SESSION CONFIG RATE */}
      <Dialog open={configOpen} onOpenChange={setConfigOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Settings className="text-indigo-600" size={20} />
              {selectedConfig ? "Edit Session Rate" : "Add Session Rate"}
            </DialogTitle>
          </DialogHeader>
          <Form {...sessionConfigForm}>
            <form onSubmit={sessionConfigForm.handleSubmit(submitSessionConfig)} className="space-y-4">
              <FormField control={sessionConfigForm.control} name="name" render={({ field }) => (
                <FormItem>
                  <FormLabel>Session Name</FormLabel>
                  <FormControl><Input placeholder="e.g. Morning Shift" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />

              <div className="grid grid-cols-2 gap-3">
                <FormField control={sessionConfigForm.control} name="startTime" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Start Time</FormLabel>
                    <FormControl><Input type="time" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={sessionConfigForm.control} name="endTime" render={({ field }) => (
                  <FormItem>
                    <FormLabel>End Time</FormLabel>
                    <FormControl><Input type="time" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <FormField control={sessionConfigForm.control} name="payAmount" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Pay Amount (₹)</FormLabel>
                    <FormControl><Input type="number" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={sessionConfigForm.control} name="order" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Order Proximity</FormLabel>
                    <FormControl><Input type="number" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>

              <FormField control={sessionConfigForm.control} name="isOvertime" render={({ field }) => (
                <FormItem className="flex items-center justify-between p-3 bg-slate-50 border rounded-lg">
                  <div className="space-y-0.5">
                    <FormLabel className="font-bold text-sm">Overtime Premium Class</FormLabel>
                    <p className="text-xs text-muted-foreground">Classifies this session as Overtime pay in computations.</p>
                  </div>
                  <FormControl>
                    <input
                      type="checkbox"
                      checked={field.value}
                      onChange={field.onChange}
                      className="w-4 h-4 text-indigo-600 rounded focus:ring-indigo-500"
                    />
                  </FormControl>
                </FormItem>
              )} />

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setConfigOpen(false)}>Cancel</Button>
                <Button type="submit" className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold">
                  {selectedConfig ? "Update Rate" : "Create Rate"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </HrLayout>
  );
}
