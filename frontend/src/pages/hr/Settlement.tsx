import { useState, useRef, useEffect } from "react";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  useListAdvances, useCreateAdvance, useUpdateAdvance, useAdvanceDetail, useDeleteAdvance,
  getListAdvancesQueryKey, getAdvanceDetailQueryKey,
  type Advance, type AdvanceRepaymentItem,
} from "@/lib/api-client";
import { useListEmployees } from "@/lib/api-client";
import { useQueryClient } from "@tanstack/react-query";
import {
  Plus, IndianRupee, CheckCircle2, XCircle,
  User, Phone, Mail, Building2, Clock,
  ChevronRight, History, CheckCheck, Calendar, Search, X, Trash2,
} from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
//  Constants
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<string, { label: string; cls: string }> = {
  pending:  { label: "Pending Approval", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  approved: { label: "Active",           cls: "bg-green-50 text-green-700 border-green-200" },
  rejected: { label: "Rejected",         cls: "bg-red-50 text-red-700 border-red-200" },
  closed:   { label: "Completed",        cls: "bg-gray-50 text-gray-600 border-gray-200" },
};

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const MONTH_FULL = ["January","February","March","April","May","June","July","August","September","October","November","December"];

// ─────────────────────────────────────────────────────────────────────────────
//  Employee Code Autocomplete
// ─────────────────────────────────────────────────────────────────────────────

type EmpOption = { id: number; employeeCode: string; name: string; department?: string | null };

function EmployeeCodeInput({
  value,
  onChange,
  employees,
  onSelect,
}: {
  value: string;
  onChange: (v: string) => void;
  employees: EmpOption[];
  onSelect: (emp: EmpOption) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const filtered = value.trim()
    ? employees.filter(
        e =>
          e.employeeCode.toLowerCase().includes(value.toLowerCase()) ||
          e.name.toLowerCase().includes(value.toLowerCase()),
      ).slice(0, 8)
    : [];

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const selectedEmp = employees.find(e => e.employeeCode.toLowerCase() === value.toLowerCase());

  return (
    <div ref={containerRef} className="relative">
      <Input
        value={value}
        onChange={e => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        placeholder="e.g. EMP001 or name"
        autoComplete="off"
      />
      {selectedEmp && (
        <p className="text-xs text-green-600 font-medium mt-1">
          ✓ {selectedEmp.name}{selectedEmp.department ? ` · ${selectedEmp.department}` : ""}
        </p>
      )}
      {open && filtered.length > 0 && (
        <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-white border rounded-xl shadow-lg overflow-hidden">
          {filtered.map(emp => (
            <button
              key={emp.id}
              type="button"
              className="w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-gray-50 text-left transition-colors"
              onMouseDown={e => {
                e.preventDefault();
                onSelect(emp);
                setOpen(false);
              }}
            >
              <div className="w-7 h-7 rounded-full bg-gray-100 flex items-center justify-center shrink-0">
                <User size={12} className="text-gray-400" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold truncate">{emp.name}</p>
                <p className="text-xs text-gray-400">{emp.employeeCode}{emp.department ? ` · ${emp.department}` : ""}</p>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Advance Detail Drawer
// ─────────────────────────────────────────────────────────────────────────────

function AdvanceDetailDrawer({
  advanceId,
  open,
  onClose,
  onDelete,
}: {
  advanceId: number | null;
  open: boolean;
  onClose: () => void;
  onDelete?: (adv: Advance) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const updateMutation = useUpdateAdvance();

  const { data: adv, isLoading } = useAdvanceDetail(advanceId);

  const progress = adv && adv.amount > 0
    ? Math.round((adv.totalRepaid / adv.amount) * 100)
    : 0;

  const handleStatusChange = async (status: Advance["status"]) => {
    if (!adv) return;
    try {
      await updateMutation.mutateAsync({ id: adv.id, data: { status } });
      toast({ title: `Advance ${status}` });
      queryClient.invalidateQueries({ queryKey: getListAdvancesQueryKey() });
      queryClient.invalidateQueries({ queryKey: getAdvanceDetailQueryKey(adv.id) });
    } catch {
      toast({ title: "Failed to update", variant: "destructive" });
    }
  };

  return (
    <Sheet open={open} onOpenChange={onClose}>
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
        {isLoading || !adv ? (
          <div className="space-y-4 pt-6">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full rounded-xl" />
            ))}
          </div>
        ) : (
          <div className="space-y-5 pt-2 pb-8">
            <SheetHeader className="pb-0">
              <div className="flex items-center justify-between">
                <SheetTitle className="text-base">
                  {adv.advanceType === "term" ? "Term Loan" : "General Advance"} — Detail
                </SheetTitle>
                {onDelete && (
                  <button
                    onClick={() => { onDelete(adv); onClose(); }}
                    className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                    title="Delete advance"
                  >
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            </SheetHeader>

            {/* ── Employee Info ─────────────────────────────────────────── */}
            <div className="bg-gray-50 rounded-xl p-4 space-y-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center shrink-0">
                  <User size={18} className="text-gray-500" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-bold text-sm">{adv.employeeName}</p>
                  <p className="text-xs text-muted-foreground">{adv.employeeCode}</p>
                </div>
                <Badge className={`text-xs border shrink-0 ${STATUS_CONFIG[adv.status]?.cls}`}>
                  {STATUS_CONFIG[adv.status]?.label}
                </Badge>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                {adv.employeeDepartment && (
                  <div className="flex items-center gap-1.5 text-gray-600">
                    <Building2 size={11} className="shrink-0" />{adv.employeeDepartment}
                  </div>
                )}
                {adv.employeeDesignation && (
                  <div className="flex items-center gap-1.5 text-gray-600">
                    <User size={11} className="shrink-0" />{adv.employeeDesignation}
                  </div>
                )}
                {adv.employeePhone && (
                  <div className="flex items-center gap-1.5 text-gray-600">
                    <Phone size={11} className="shrink-0" />{adv.employeePhone}
                  </div>
                )}
                {adv.employeeEmail && (
                  <div className="flex items-center gap-1.5 text-gray-600 truncate">
                    <Mail size={11} className="shrink-0" />
                    <span className="truncate">{adv.employeeEmail}</span>
                  </div>
                )}
              </div>
            </div>

            {/* ── Loan Details ──────────────────────────────────────────── */}
            <div className="space-y-2">
              <p className="text-xs font-bold uppercase tracking-wider text-gray-400">Loan Details</p>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { label: "Total Amount", value: `₹${adv.amount.toLocaleString()}`,     color: "text-blue-700" },
                  { label: "Repaid",       value: `₹${adv.totalRepaid.toLocaleString()}`, color: "text-green-600" },
                  { label: "Outstanding",  value: `₹${adv.outstanding.toLocaleString()}`, color: "text-red-500" },
                ].map(s => (
                  <div key={s.label} className="bg-white border rounded-xl p-3 text-center">
                    <p className="text-xs text-gray-400 mb-0.5">{s.label}</p>
                    <p className={`text-sm font-black ${s.color}`}>{s.value}</p>
                  </div>
                ))}
              </div>

              <div className="space-y-1">
                <div className="flex justify-between text-xs text-gray-400">
                  <span>Recovery progress</span><span>{progress}%</span>
                </div>
                <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                  <div className="h-full bg-green-500 rounded-full transition-all" style={{ width: `${progress}%` }} />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs">
                {adv.purpose && (
                  <div className="col-span-2 flex gap-1.5 text-gray-500">
                    <span className="font-medium text-gray-700">Purpose:</span> {adv.purpose}
                  </div>
                )}
                {adv.repaymentStartMonth && (
                  <div className="flex gap-1.5 text-gray-500">
                    <Calendar size={11} className="mt-0.5 shrink-0" />
                    Starts: {MONTHS[(adv.repaymentStartMonth ?? 1) - 1]} {adv.repaymentStartYear}
                  </div>
                )}
                {adv.advanceType === "term" && adv.emiAmount > 0 && (
                  <div className="flex gap-1.5 text-gray-600 font-medium">
                    <IndianRupee size={11} className="mt-0.5 shrink-0" />
                    EMI: ₹{adv.emiAmount.toLocaleString()}/month
                    {adv.repaymentMonths && <span className="text-gray-400 font-normal"> · {adv.repaymentMonths} months</span>}
                  </div>
                )}
                {adv.createdAt && (
                  <div className="flex gap-1.5 text-gray-400">
                    <Clock size={11} className="mt-0.5 shrink-0" />
                    Created: {new Date(adv.createdAt).toLocaleDateString("en-IN")}
                  </div>
                )}
              </div>
            </div>

            {/* ── Actions ───────────────────────────────────────────────── */}
            {adv.status === "pending" && (
              <div className="flex gap-2">
                <Button
                  size="sm"
                  className="flex-1 gap-1.5 bg-green-600 hover:bg-green-700 h-9"
                  onClick={() => handleStatusChange("approved")}
                  disabled={updateMutation.isPending}
                >
                  <CheckCircle2 size={13} /> Approve
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="flex-1 gap-1.5 text-red-500 border-red-200 h-9"
                  onClick={() => handleStatusChange("rejected")}
                  disabled={updateMutation.isPending}
                >
                  <XCircle size={13} /> Reject
                </Button>
              </div>
            )}

            {adv.status === "closed" && (
              <div className="flex items-center justify-center gap-2 py-2 bg-green-50 border border-green-200 rounded-xl">
                <CheckCheck size={15} className="text-green-600" />
                <p className="text-sm font-semibold text-green-700">Fully Repaid — Completed</p>
              </div>
            )}

            {adv.status === "approved" && (
              <div className="flex items-center gap-2 py-2 px-3 bg-blue-50 border border-blue-100 rounded-xl text-xs text-blue-700">
                <CheckCircle2 size={13} className="shrink-0" />
                Deductions are processed automatically during monthly payroll.
              </div>
            )}

            <Separator />

            {/* ── Deduction Schedule ────────────────────────────────────── */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <History size={14} className="text-gray-400" />
                <p className="text-xs font-bold uppercase tracking-wider text-gray-400">
                  Deduction Schedule ({adv.repayments?.length ?? 0})
                </p>
              </div>

              {!adv.repayments || adv.repayments.length === 0 ? (
                <p className="text-xs text-center text-muted-foreground py-6">
                  {adv.status === "pending"
                    ? "Schedule will be generated when the advance is approved."
                    : "No deduction schedule found."}
                </p>
              ) : (
                <div className="space-y-2">
                  {adv.repayments.map((r: AdvanceRepaymentItem) => (
                    <div
                      key={r.id}
                      className={`flex items-center justify-between p-3 border rounded-xl ${
                        r.isProcessed ? "bg-green-50 border-green-100" : "bg-white border-gray-100"
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                          r.isProcessed ? "bg-green-100" : "bg-gray-100"
                        }`}>
                          {r.isProcessed
                            ? <CheckCircle2 size={14} className="text-green-600" />
                            : <Clock size={14} className="text-gray-400" />
                          }
                        </div>
                        <div>
                          <p className="text-sm font-semibold">{MONTH_FULL[r.month - 1]} {r.year}</p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {r.isProcessed ? "Deducted via payroll" : "Scheduled — payroll deduction"}
                          </p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className={`text-sm font-bold ${r.isProcessed ? "text-green-600" : "text-gray-500"}`}>
                          ₹{r.amount.toLocaleString()}
                        </p>
                        <p className={`text-xs mt-0.5 font-medium ${r.isProcessed ? "text-green-500" : "text-amber-500"}`}>
                          {r.isProcessed ? "Done" : "Pending"}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Advance Card
// ─────────────────────────────────────────────────────────────────────────────

function AdvanceCard({
  a,
  onClick,
  onDelete,
  onApprove,
  onReject,
}: {
  a: Advance;
  onClick: () => void;
  onDelete?: () => void;
  onApprove?: () => void;
  onReject?: () => void;
}) {
  const s = STATUS_CONFIG[a.status] ?? STATUS_CONFIG.pending;
  const progress = a.amount > 0 ? Math.round((a.totalRepaid / a.amount) * 100) : 0;

  return (
    <Card className="border hover:shadow-md transition-all cursor-pointer group" onClick={onClick}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <p className="font-bold text-sm">{a.employeeName}</p>
              <span className="text-xs text-gray-400">{a.employeeCode}</span>
              <Badge className={`text-xs border ${s.cls}`}>{s.label}</Badge>
            </div>
            {a.purpose && <p className="text-xs text-gray-500 mb-2">{a.purpose}</p>}
            <div className="grid grid-cols-3 gap-3 text-center mb-2">
              <div>
                <p className="text-xs text-gray-400">Total</p>
                <p className="text-sm font-bold">₹{a.amount.toLocaleString()}</p>
              </div>
              <div>
                <p className="text-xs text-gray-400">Repaid</p>
                <p className="text-sm font-bold text-green-600">₹{a.totalRepaid.toLocaleString()}</p>
              </div>
              <div>
                <p className="text-xs text-gray-400">Outstanding</p>
                <p className="text-sm font-bold text-red-500">₹{a.outstanding.toLocaleString()}</p>
              </div>
            </div>
            {a.status === "approved" && a.outstanding > 0 && (
              <div>
                <div className="flex justify-between text-xs text-gray-400 mb-1">
                  <span>Recovery</span><span>{progress}%</span>
                </div>
                <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                  <div className="h-full bg-green-500 rounded-full" style={{ width: `${progress}%` }} />
                </div>
                {a.advanceType === "term" && a.emiAmount > 0 && (
                  <p className="text-xs text-gray-400 mt-1">
                    EMI: ₹{a.emiAmount.toLocaleString()}/month
                    {a.repaymentMonths && ` · ${a.repaymentMonths} months`}
                    {a.repaymentStartMonth && ` · Starts ${MONTHS[a.repaymentStartMonth - 1]} ${a.repaymentStartYear}`}
                  </p>
                )}
              </div>
            )}
            {/* Approve / Reject inline for pending tab */}
            {(onApprove || onReject) && (
              <div className="flex gap-2 mt-3" onClick={e => e.stopPropagation()}>
                {onApprove && (
                  <Button
                    size="sm"
                    className="flex-1 gap-1 bg-green-600 hover:bg-green-700 h-8 text-xs"
                    onClick={onApprove}
                  >
                    <CheckCircle2 size={12} /> Approve
                  </Button>
                )}
                {onReject && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1 gap-1 text-red-500 border-red-200 h-8 text-xs"
                    onClick={onReject}
                  >
                    <XCircle size={12} /> Reject
                  </Button>
                )}
              </div>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0 mt-0.5">
            {onDelete && (
              <button
                onClick={e => { e.stopPropagation(); onDelete(); }}
                className="p-1.5 rounded-lg text-gray-300 hover:text-red-500 hover:bg-red-50 transition-colors"
                title="Delete"
              >
                <Trash2 size={14} />
              </button>
            )}
            <ChevronRight size={16} className="text-gray-300 group-hover:text-gray-500 transition-colors" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Tab Summary Cards
// ─────────────────────────────────────────────────────────────────────────────

function TabSummaryCards({ advances, activeTab }: { advances: Advance[]; activeTab: string }) {
  const cards = (() => {
    if (activeTab === "pending") {
      const list = advances.filter(a => a.status === "pending");
      return [
        { label: "Pending Requests", value: list.length, color: "text-amber-600" },
        { label: "Total Requested", value: `₹${list.reduce((s, a) => s + a.amount, 0).toLocaleString()}`, color: "text-amber-700" },
        { label: "General / Term", value: `${list.filter(a => a.advanceType === "general").length} / ${list.filter(a => a.advanceType === "term").length}`, color: "text-gray-700" },
      ];
    }
    if (activeTab === "general") {
      const list = advances.filter(a => a.advanceType === "general" && a.status === "approved");
      return [
        { label: "Active General", value: list.length, color: "text-blue-700" },
        { label: "Total Outstanding", value: `₹${list.reduce((s, a) => s + a.outstanding, 0).toLocaleString()}`, color: "text-red-600" },
        { label: "Total Disbursed", value: `₹${list.reduce((s, a) => s + a.amount, 0).toLocaleString()}`, color: "text-gray-700" },
      ];
    }
    if (activeTab === "term") {
      const list = advances.filter(a => a.advanceType === "term" && a.status === "approved");
      return [
        { label: "Active Loans", value: list.length, color: "text-purple-700" },
        { label: "Total Outstanding", value: `₹${list.reduce((s, a) => s + a.outstanding, 0).toLocaleString()}`, color: "text-red-600" },
        { label: "Monthly EMI Total", value: `₹${list.reduce((s, a) => s + a.emiAmount, 0).toLocaleString()}`, color: "text-purple-600" },
      ];
    }
    if (activeTab === "completed") {
      const list = advances.filter(a => a.status === "closed");
      return [
        { label: "Completed", value: list.length, color: "text-green-700" },
        { label: "Total Repaid", value: `₹${list.reduce((s, a) => s + a.totalRepaid, 0).toLocaleString()}`, color: "text-green-600" },
        { label: "General / Term", value: `${list.filter(a => a.advanceType === "general").length} / ${list.filter(a => a.advanceType === "term").length}`, color: "text-gray-700" },
      ];
    }
    if (activeTab === "rejected") {
      const list = advances.filter(a => a.status === "rejected");
      return [
        { label: "Rejected", value: list.length, color: "text-red-700" },
        { label: "Total Rejected Amount", value: `₹${list.reduce((s, a) => s + a.amount, 0).toLocaleString()}`, color: "text-red-600" },
        { label: "General / Term", value: `${list.filter(a => a.advanceType === "general").length} / ${list.filter(a => a.advanceType === "term").length}`, color: "text-gray-700" },
      ];
    }
    return [];
  })();

  return (
    <div className="grid grid-cols-3 gap-4">
      {cards.map(c => (
        <Card key={c.label} className="border-0 shadow-sm">
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground font-medium">{c.label}</p>
            <p className={`text-xl font-black mt-0.5 ${c.color}`}>{c.value}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Main Settlement page
// ─────────────────────────────────────────────────────────────────────────────

export default function Settlement() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [showDialog, setShowDialog] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Advance | null>(null);
  const [activeTab, setActiveTab] = useState("pending");

  const nextMonth = new Date().getMonth() + 2 > 12 ? 1 : new Date().getMonth() + 2;
  const [form, setForm] = useState({
    employeeCode: "", advanceType: "general",
    amount: "", purpose: "",
    repaymentMonths: "", emiAmount: "",
    repaymentStartMonth: nextMonth,
    repaymentStartYear: new Date().getFullYear(),
  });

  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState<"all" | "general" | "term">("all");

  const { data: advances, isLoading } = useListAdvances();
  const { data: employees } = useListEmployees({ status: "active" });
  const createMutation = useCreateAdvance();
  const updateMutation = useUpdateAdvance();
  const deleteMutation = useDeleteAdvance();

  const allAdvances = advances ?? [];

  const empOptions: EmpOption[] = (employees ?? []).map(e => ({
    id: e.id,
    employeeCode: e.employeeCode,
    name: `${e.firstName} ${e.lastName}`,
    department: e.departmentName,
  }));

  const computedEmi = (() => {
    const amt = parseFloat(form.amount);
    const months = parseInt(form.repaymentMonths, 10);
    const manualEmi = parseFloat(form.emiAmount);
    if (form.advanceType !== "term") return null;
    if (manualEmi > 0) return manualEmi;
    if (amt > 0 && months > 0) return Math.ceil((amt / months) * 100) / 100;
    return null;
  })();

  const applyFilters = (list: Advance[]) => {
    const q = search.trim().toLowerCase();
    return list.filter(a => {
      const matchSearch = !q ||
        a.employeeName.toLowerCase().includes(q) ||
        a.employeeCode.toLowerCase().includes(q) ||
        (a.purpose ?? "").toLowerCase().includes(q);
      const matchType = filterType === "all" || a.advanceType === filterType;
      return matchSearch && matchType;
    });
  };

  const pendingAdvances   = applyFilters(allAdvances.filter(a => a.status === "pending"));
  const generalAdvances   = applyFilters(allAdvances.filter(a => a.advanceType === "general" && a.status === "approved"));
  const termAdvances      = applyFilters(allAdvances.filter(a => a.advanceType === "term"    && a.status === "approved"));
  const completedAdvances = applyFilters(allAdvances.filter(a => a.status === "closed"));
  const rejectedAdvances  = applyFilters(allAdvances.filter(a => a.status === "rejected"));

  const handleQuickStatus = async (id: number, status: Advance["status"]) => {
    try {
      await updateMutation.mutateAsync({ id, data: { status } });
      toast({ title: `Advance ${status}` });
      queryClient.invalidateQueries({ queryKey: getListAdvancesQueryKey() });
    } catch {
      toast({ title: "Failed to update advance", variant: "destructive" });
    }
  };

  const createAdvance = async () => {
    if (!form.employeeCode || !form.amount) {
      toast({ title: "Employee code and amount are required", variant: "destructive" });
      return;
    }
    const employee = empOptions.find(
      e => e.employeeCode.toLowerCase() === form.employeeCode.trim().toLowerCase(),
    );
    if (!employee) {
      toast({ title: `Employee "${form.employeeCode}" not found`, variant: "destructive" });
      return;
    }
    const amt = parseFloat(form.amount);
    if (!amt || amt <= 0) {
      toast({ title: "Enter a valid amount", variant: "destructive" });
      return;
    }
    const months = form.advanceType === "term" ? parseInt(form.repaymentMonths, 10) || undefined : undefined;
    const emi    = form.advanceType === "term" ? parseFloat(form.emiAmount) || undefined : undefined;
    if (form.advanceType === "term" && !months && !emi) {
      toast({ title: "Enter repayment months or EMI amount for term loans", variant: "destructive" });
      return;
    }
    try {
      await createMutation.mutateAsync({
        employeeId: employee.id,
        advanceType: form.advanceType,
        amount: amt,
        purpose: form.purpose || undefined,
        repaymentMonths: months,
        emiAmount: emi,
        repaymentStartMonth: form.repaymentStartMonth,
        repaymentStartYear: form.repaymentStartYear,
      });
    } catch {
      toast({ title: "Failed to create advance", variant: "destructive" });
      return;
    }
    toast({ title: "Advance created" });
    setShowDialog(false);
    const nm = new Date().getMonth() + 2 > 12 ? 1 : new Date().getMonth() + 2;
    setForm({
      employeeCode: "", advanceType: "general", amount: "", purpose: "",
      repaymentMonths: "", emiAmount: "",
      repaymentStartMonth: nm,
      repaymentStartYear: new Date().getFullYear(),
    });
    queryClient.invalidateQueries({ queryKey: getListAdvancesQueryKey() });
    setActiveTab("pending");
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteMutation.mutateAsync(deleteTarget.id);
      toast({ title: "Advance deleted" });
      queryClient.invalidateQueries({ queryKey: getListAdvancesQueryKey() });
    } catch {
      toast({ title: "Failed to delete advance", variant: "destructive" });
    } finally {
      setDeleteTarget(null);
    }
  };

  const SkeletonCards = () => (
    <>
      {Array.from({ length: 2 }).map((_, i) => (
        <Card key={i}><CardContent className="p-4">
          <Skeleton className="h-5 w-40 mb-2" /><Skeleton className="h-4 w-64" />
        </CardContent></Card>
      ))}
    </>
  );

  return (
    <HrLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-black text-gray-900">Settlement</h2>
            <p className="text-muted-foreground text-sm mt-0.5">Manage general advances and term loans</p>
          </div>
          <Button className="gap-2" onClick={() => setShowDialog(true)}>
            <Plus size={15} /> New Advance
          </Button>
        </div>

        {/* Tab-specific summary cards */}
        {isLoading ? (
          <div className="grid grid-cols-3 gap-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <Card key={i} className="border-0 shadow-sm">
                <CardContent className="p-4">
                  <Skeleton className="h-3 w-24 mb-2" /><Skeleton className="h-6 w-20" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <TabSummaryCards advances={allAdvances} activeTab={activeTab} />
        )}

        {/* Search & Filter */}
        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative flex-1 min-w-48">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by name, code, or purpose…"
              className="w-full h-9 pl-8 pr-8 rounded-md border text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring"
            />
            {search && (
              <button onClick={() => setSearch("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                <X size={13} />
              </button>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            {(["all","general","term"] as const).map(t => (
              <button
                key={t}
                onClick={() => setFilterType(t)}
                className={`text-xs px-3 py-1.5 rounded-full border font-medium transition-all ${
                  filterType === t
                    ? "bg-gray-900 text-white border-gray-900"
                    : "bg-white text-gray-600 border-gray-200 hover:border-gray-400"
                }`}
              >
                {t === "all" ? "All Types" : t === "general" ? "General" : "Term Loan"}
              </button>
            ))}
          </div>
        </div>

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="bg-gray-100">
            <TabsTrigger value="pending" className="relative">
              Pending Approval
              {pendingAdvances.length > 0 && (
                <span className="ml-1.5 inline-flex items-center justify-center min-w-[18px] h-4 px-1 text-[10px] font-bold rounded-full bg-amber-500 text-white">
                  {allAdvances.filter(a => a.status === "pending").length}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="general">General ({generalAdvances.length})</TabsTrigger>
            <TabsTrigger value="term">Term Loan ({termAdvances.length})</TabsTrigger>
            <TabsTrigger value="completed">Completed ({completedAdvances.length})</TabsTrigger>
            <TabsTrigger value="rejected" className="data-[state=active]:bg-red-600 data-[state=active]:text-white">
              Rejected ({rejectedAdvances.length})
            </TabsTrigger>
          </TabsList>

          {/* Pending Approval */}
          <TabsContent value="pending" className="mt-4 space-y-3">
            <p className="text-xs text-gray-500 bg-amber-50 border border-amber-100 p-3 rounded-lg">
              <strong>Pending Approval:</strong> Advance requests submitted by HR awaiting approval. Approve to auto-generate the repayment schedule.
            </p>
            {isLoading ? <SkeletonCards /> : pendingAdvances.length === 0 ? (
              <div className="text-center py-10 text-muted-foreground text-sm">No pending advance requests.</div>
            ) : (
              pendingAdvances.map(a => (
                <AdvanceCard
                  key={a.id}
                  a={a}
                  onClick={() => setSelectedId(a.id)}
                  onDelete={() => setDeleteTarget(a)}
                  onApprove={() => handleQuickStatus(a.id, "approved")}
                  onReject={() => handleQuickStatus(a.id, "rejected")}
                />
              ))
            )}
          </TabsContent>

          {/* General Advance */}
          <TabsContent value="general" className="mt-4 space-y-3">
            <p className="text-xs text-gray-500 bg-blue-50 border border-blue-100 p-3 rounded-lg">
              <strong>General Advance:</strong> Full amount is deducted automatically from the specified month's payroll.
            </p>
            {isLoading ? <SkeletonCards /> : generalAdvances.length === 0 ? (
              <div className="text-center py-10 text-muted-foreground text-sm">No active general advances.</div>
            ) : (
              generalAdvances.map(a => (
                <AdvanceCard key={a.id} a={a} onClick={() => setSelectedId(a.id)} onDelete={() => setDeleteTarget(a)} />
              ))
            )}
          </TabsContent>

          {/* Term Loan */}
          <TabsContent value="term" className="mt-4 space-y-3">
            <p className="text-xs text-gray-500 bg-purple-50 border border-purple-100 p-3 rounded-lg">
              <strong>Term Advance / Loan:</strong> Monthly EMI deducted automatically from payroll each month per the repayment schedule.
            </p>
            {isLoading ? <SkeletonCards /> : termAdvances.length === 0 ? (
              <div className="text-center py-10 text-muted-foreground text-sm">No active term loans.</div>
            ) : (
              termAdvances.map(a => (
                <AdvanceCard key={a.id} a={a} onClick={() => setSelectedId(a.id)} onDelete={() => setDeleteTarget(a)} />
              ))
            )}
          </TabsContent>

          {/* Completed */}
          <TabsContent value="completed" className="mt-4 space-y-3">
            <p className="text-xs text-gray-500 bg-green-50 border border-green-100 p-3 rounded-lg">
              <strong>Completed:</strong> Fully repaid advances and loans.
            </p>
            {isLoading ? <SkeletonCards /> : completedAdvances.length === 0 ? (
              <div className="text-center py-10 text-muted-foreground text-sm">No completed settlements yet.</div>
            ) : (
              completedAdvances.map(a => (
                <AdvanceCard key={a.id} a={a} onClick={() => setSelectedId(a.id)} onDelete={() => setDeleteTarget(a)} />
              ))
            )}
          </TabsContent>

          {/* Rejected */}
          <TabsContent value="rejected" className="mt-4 space-y-3">
            <p className="text-xs text-gray-500 bg-red-50 border border-red-100 p-3 rounded-lg">
              <strong>Rejected:</strong> Advance requests declined by HR.
            </p>
            {isLoading ? <SkeletonCards /> : rejectedAdvances.length === 0 ? (
              <div className="text-center py-10 text-muted-foreground text-sm">No rejected requests.</div>
            ) : (
              rejectedAdvances.map(a => (
                <AdvanceCard key={a.id} a={a} onClick={() => setSelectedId(a.id)} onDelete={() => setDeleteTarget(a)} />
              ))
            )}
          </TabsContent>
        </Tabs>

        {/* Create Dialog */}
        <Dialog open={showDialog} onOpenChange={setShowDialog}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Create New Advance</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div className="space-y-1.5">
                <Label>Employee <span className="text-red-500">*</span></Label>
                <EmployeeCodeInput
                  value={form.employeeCode}
                  onChange={v => setForm(f => ({ ...f, employeeCode: v }))}
                  employees={empOptions}
                  onSelect={emp => setForm(f => ({ ...f, employeeCode: emp.employeeCode }))}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Advance Type</Label>
                  <select
                    value={form.advanceType}
                    onChange={e => setForm(f => ({ ...f, advanceType: e.target.value, repaymentMonths: "", emiAmount: "" }))}
                    className="w-full h-9 rounded-md border px-3 text-sm bg-background"
                  >
                    <option value="general">General Advance</option>
                    <option value="term">Term Advance (Loan)</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label>Amount (₹) <span className="text-red-500">*</span></Label>
                  <Input
                    type="number" value={form.amount}
                    onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} placeholder="0"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Purpose</Label>
                <Input
                  value={form.purpose}
                  onChange={e => setForm(f => ({ ...f, purpose: e.target.value }))}
                  placeholder="Reason for advance"
                />
              </div>

              {form.advanceType === "term" && (
                <div className="space-y-3 p-3 bg-purple-50 border border-purple-100 rounded-lg">
                  <p className="text-xs font-semibold text-purple-700">Repayment Details</p>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label className="text-xs">Repayment Months</Label>
                      <Input
                        type="number"
                        value={form.repaymentMonths}
                        onChange={e => setForm(f => ({ ...f, repaymentMonths: e.target.value, emiAmount: "" }))}
                        placeholder="e.g. 12"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Monthly EMI (₹)</Label>
                      <Input
                        type="number"
                        value={form.emiAmount}
                        onChange={e => setForm(f => ({ ...f, emiAmount: e.target.value, repaymentMonths: "" }))}
                        placeholder="e.g. 5000"
                      />
                    </div>
                  </div>
                  {computedEmi !== null && (
                    <p className="text-xs text-purple-600">
                      Monthly deduction: <strong>₹{computedEmi.toLocaleString()}</strong>/month
                    </p>
                  )}
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>{form.advanceType === "general" ? "Deduction Month" : "Start Month"}</Label>
                  <select
                    value={form.repaymentStartMonth}
                    onChange={e => setForm(f => ({ ...f, repaymentStartMonth: Number(e.target.value) }))}
                    className="w-full h-9 rounded-md border px-3 text-sm bg-background"
                  >
                    {MONTHS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label>Year</Label>
                  <Input
                    type="number" value={form.repaymentStartYear}
                    onChange={e => setForm(f => ({ ...f, repaymentStartYear: Number(e.target.value) }))}
                  />
                </div>
              </div>

              <div className="flex gap-3 pt-2">
                <Button variant="outline" className="flex-1" onClick={() => setShowDialog(false)}>Cancel</Button>
                <Button className="flex-1" onClick={createAdvance} disabled={createMutation.isPending}>
                  {createMutation.isPending ? "Creating…" : "Create Advance"}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        {/* Delete Confirmation */}
        <AlertDialog open={!!deleteTarget} onOpenChange={open => !open && setDeleteTarget(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete Advance?</AlertDialogTitle>
              <AlertDialogDescription>
                This will permanently delete the advance for{" "}
                <strong>{deleteTarget?.employeeName}</strong> (₹{deleteTarget?.amount.toLocaleString()}).
                This cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-red-600 hover:bg-red-700"
                onClick={handleDelete}
                disabled={deleteMutation.isPending}
              >
                {deleteMutation.isPending ? "Deleting…" : "Delete"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Detail Drawer */}
        <AdvanceDetailDrawer
          advanceId={selectedId}
          open={selectedId !== null}
          onClose={() => setSelectedId(null)}
          onDelete={adv => { setSelectedId(null); setDeleteTarget(adv); }}
        />
      </div>
    </HrLayout>
  );
}
