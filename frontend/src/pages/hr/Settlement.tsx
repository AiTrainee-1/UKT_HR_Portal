import { useState } from "react";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  useListAdvances, useCreateAdvance, useUpdateAdvance, useAdvanceDetail,
  useCreateAdvanceRepayment,
  getListAdvancesQueryKey, getAdvanceDetailQueryKey,
  type Advance, type AdvanceRepaymentItem,
} from "@/lib/api-client";
import { useListEmployees } from "@/lib/api-client";
import { useQueryClient } from "@tanstack/react-query";
import {
  Plus, IndianRupee, CheckCircle2, XCircle,
  User, Phone, Mail, Building2, Banknote, QrCode, Clock, AlertTriangle,
  ChevronRight, History, CreditCard, CheckCheck, Calendar, Search, X,
} from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
//  Constants
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<string, { label: string; cls: string }> = {
  pending:  { label: "Pending",  cls: "bg-amber-50 text-amber-700 border-amber-200" },
  approved: { label: "Active",   cls: "bg-green-50 text-green-700 border-green-200" },
  rejected: { label: "Rejected", cls: "bg-red-50 text-red-700 border-red-200" },
  closed:   { label: "Completed",cls: "bg-gray-50 text-gray-600 border-gray-200" },
};

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const MONTH_FULL = ["January","February","March","April","May","June","July","August","September","October","November","December"];

// ─────────────────────────────────────────────────────────────────────────────
//  Add Payment Dialog
// ─────────────────────────────────────────────────────────────────────────────

function AddPaymentDialog({
  advance,
  open,
  onClose,
  onDone,
}: {
  advance: Advance;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const now = new Date();
  const [payMethod, setPayMethod] = useState<"cash" | "gpay">("cash");
  const [amount, setAmount] = useState(
    advance.advanceType === "term"
      ? String(advance.emiAmount)
      : String(advance.outstanding)
  );
  const [notes, setNotes] = useState("");
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());

  const mutation = useCreateAdvanceRepayment();

  const handleDone = async () => {
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) {
      toast({ title: "Enter a valid amount", variant: "destructive" });
      return;
    }
    if (amt > advance.outstanding) {
      toast({ title: `Amount cannot exceed outstanding ₹${advance.outstanding.toLocaleString()}`, variant: "destructive" });
      return;
    }
    try {
      await mutation.mutateAsync({
        advanceId: advance.id,
        data: { month, year, amount: amt, paymentMethod: payMethod, notes: notes || undefined },
      });
      toast({ title: `Payment of ₹${amt.toLocaleString()} recorded successfully` });
      onDone();
      onClose();
    } catch {
      toast({ title: "Failed to record payment", variant: "destructive" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-base">Record Payment</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 pt-1">
          {/* Amount */}
          <div className="space-y-1.5">
            <Label>Amount (₹) <span className="text-red-500">*</span></Label>
            <Input
              type="number"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              placeholder="0"
            />
            {advance.advanceType === "term" && (
              <p className="text-xs text-muted-foreground">EMI: ₹{advance.emiAmount.toLocaleString()}/month</p>
            )}
            <p className="text-xs text-muted-foreground">
              Outstanding: <span className="text-red-500 font-semibold">₹{advance.outstanding.toLocaleString()}</span>
            </p>
          </div>

          {/* Payment period */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Payment Month</Label>
              <select
                value={month}
                onChange={e => setMonth(Number(e.target.value))}
                className="w-full h-9 rounded-md border px-3 text-sm bg-background"
              >
                {MONTHS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label>Year</Label>
              <Input
                type="number"
                value={year}
                onChange={e => setYear(Number(e.target.value))}
              />
            </div>
          </div>

          {/* Payment method */}
          <div className="space-y-2">
            <Label>Payment Method</Label>
            <div className="grid grid-cols-2 gap-2">
              {(["cash", "gpay"] as const).map(m => (
                <button
                  key={m}
                  onClick={() => setPayMethod(m)}
                  className={`flex items-center justify-center gap-2 h-10 rounded-lg border text-sm font-medium transition-all ${
                    payMethod === m
                      ? "bg-gray-900 text-white border-gray-900"
                      : "bg-white text-gray-600 border-gray-200 hover:border-gray-400"
                  }`}
                >
                  {m === "cash" ? <Banknote size={14} /> : <QrCode size={14} />}
                  {m === "cash" ? "Hand Cash" : "GPay"}
                </button>
              ))}
            </div>
          </div>

          {/* GPay QR */}
          {payMethod === "gpay" && (
            <div className="flex flex-col items-center gap-2 p-4 bg-gray-50 rounded-xl border border-dashed">
              <p className="text-xs font-semibold text-gray-600">Scan to Pay via GPay</p>
              <img
                src="/gpay-qr.png"
                alt="GPay QR Code"
                className="w-40 h-40 object-contain rounded-lg border bg-white p-1"
                onError={e => {
                  (e.target as HTMLImageElement).style.display = "none";
                  (e.target as HTMLImageElement).nextElementSibling?.classList.remove("hidden");
                }}
              />
              <div className="hidden flex-col items-center gap-1 w-40 h-40 border rounded-lg bg-white justify-center">
                <QrCode size={32} className="text-gray-300" />
                <p className="text-xs text-gray-400 text-center px-2">Add gpay-qr.png to public folder</p>
              </div>
              <p className="text-xs text-muted-foreground">After payment, click Done to confirm</p>
            </div>
          )}

          {/* Notes */}
          <div className="space-y-1.5">
            <Label>Notes (optional)</Label>
            <Input
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="e.g. paid on time"
            />
          </div>

          <div className="flex gap-3 pt-1">
            <Button variant="outline" className="flex-1" onClick={onClose}>Cancel</Button>
            <Button
              className="flex-1 gap-2 bg-green-600 hover:bg-green-700"
              onClick={handleDone}
              disabled={mutation.isPending}
            >
              <CheckCheck size={14} />
              {mutation.isPending ? "Saving…" : "Done — Record Payment"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Advance Detail Drawer
// ─────────────────────────────────────────────────────────────────────────────

function AdvanceDetailDrawer({
  advanceId,
  open,
  onClose,
}: {
  advanceId: number | null;
  open: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [showPayment, setShowPayment] = useState(false);
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

  const refreshAfterPayment = () => {
    if (!adv) return;
    queryClient.invalidateQueries({ queryKey: getListAdvancesQueryKey() });
    queryClient.invalidateQueries({ queryKey: getAdvanceDetailQueryKey(adv.id) });
  };

  const methodLabel = (m: string) => m === "gpay" ? "GPay" : "Hand Cash";
  const methodIcon = (m: string) => m === "gpay"
    ? <QrCode size={11} className="text-blue-500" />
    : <Banknote size={11} className="text-green-600" />;

  return (
    <>
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
                <SheetTitle className="text-base flex items-center gap-2">
                  {adv.advanceType === "term" ? "Term Loan" : "General Advance"} — Detail
                </SheetTitle>
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
                      <Building2 size={11} className="shrink-0" />
                      {adv.employeeDepartment}
                    </div>
                  )}
                  {adv.employeeDesignation && (
                    <div className="flex items-center gap-1.5 text-gray-600">
                      <User size={11} className="shrink-0" />
                      {adv.employeeDesignation}
                    </div>
                  )}
                  {adv.employeePhone && (
                    <div className="flex items-center gap-1.5 text-gray-600">
                      <Phone size={11} className="shrink-0" />
                      {adv.employeePhone}
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
                    { label: "Total Amount",  value: `₹${adv.amount.toLocaleString()}`,        color: "text-blue-700" },
                    { label: "Repaid",        value: `₹${adv.totalRepaid.toLocaleString()}`,    color: "text-green-600" },
                    { label: "Outstanding",   value: `₹${adv.outstanding.toLocaleString()}`,    color: "text-red-500" },
                  ].map(s => (
                    <div key={s.label} className="bg-white border rounded-xl p-3 text-center">
                      <p className="text-xs text-gray-400 mb-0.5">{s.label}</p>
                      <p className={`text-sm font-black ${s.color}`}>{s.value}</p>
                    </div>
                  ))}
                </div>

                {/* Progress bar */}
                <div className="space-y-1">
                  <div className="flex justify-between text-xs text-gray-400">
                    <span>Recovery progress</span><span>{progress}%</span>
                  </div>
                  <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-green-500 rounded-full transition-all"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                </div>

                {/* Loan meta */}
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

              {/* ── Delay / Overdue Tracking ──────────────────────────────── */}
              {adv.overdueMonths && adv.overdueMonths.length > 0 && (
                <div className="bg-red-50 border border-red-200 rounded-xl p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <AlertTriangle size={13} className="text-red-500" />
                    <p className="text-xs font-bold text-red-600">
                      {adv.overdueMonths.length} Overdue Month{adv.overdueMonths.length > 1 ? "s" : ""}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {adv.overdueMonths.map(m => (
                      <span
                        key={`${m.year}-${m.month}`}
                        className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full"
                      >
                        {m.label}
                      </span>
                    ))}
                  </div>
                </div>
              )}

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

              {adv.status === "approved" && adv.outstanding > 0 && (
                <Button
                  className="w-full gap-2"
                  onClick={() => setShowPayment(true)}
                >
                  <CreditCard size={14} /> Add Payment
                </Button>
              )}

              {adv.status === "closed" && (
                <div className="flex items-center justify-center gap-2 py-2 bg-green-50 border border-green-200 rounded-xl">
                  <CheckCheck size={15} className="text-green-600" />
                  <p className="text-sm font-semibold text-green-700">Fully Repaid — Completed</p>
                </div>
              )}

              <Separator />

              {/* ── Payment History ───────────────────────────────────────── */}
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <History size={14} className="text-gray-400" />
                  <p className="text-xs font-bold uppercase tracking-wider text-gray-400">
                    Payment History ({adv.repayments?.length ?? 0})
                  </p>
                </div>

                {!adv.repayments || adv.repayments.length === 0 ? (
                  <p className="text-xs text-center text-muted-foreground py-6">No payments recorded yet.</p>
                ) : (
                  <div className="space-y-2">
                    {adv.repayments.map((r: AdvanceRepaymentItem) => (
                      <div
                        key={r.id}
                        className="flex items-center justify-between p-3 bg-white border rounded-xl"
                      >
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-lg bg-green-50 flex items-center justify-center shrink-0">
                            <CheckCircle2 size={14} className="text-green-600" />
                          </div>
                          <div>
                            <p className="text-sm font-semibold">
                              {MONTH_FULL[r.month - 1]} {r.year}
                            </p>
                            <div className="flex items-center gap-1 text-xs text-muted-foreground mt-0.5">
                              {methodIcon(r.paymentMethod)}
                              <span>{methodLabel(r.paymentMethod)}</span>
                              {r.notes && <span className="text-gray-400">· {r.notes}</span>}
                            </div>
                          </div>
                        </div>
                        <div className="text-right">
                          <p className="text-sm font-bold text-green-600">+₹{r.amount.toLocaleString()}</p>
                          {r.createdAt && (
                            <p className="text-xs text-gray-400">
                              {new Date(r.createdAt).toLocaleDateString("en-IN")}
                            </p>
                          )}
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

      {adv && (
        <AddPaymentDialog
          advance={adv}
          open={showPayment}
          onClose={() => setShowPayment(false)}
          onDone={refreshAfterPayment}
        />
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Advance Card (list item)
// ─────────────────────────────────────────────────────────────────────────────

function AdvanceCard({ a, onClick }: { a: Advance; onClick: () => void }) {
  const s = STATUS_CONFIG[a.status] ?? STATUS_CONFIG.pending;
  const progress = a.amount > 0 ? Math.round((a.totalRepaid / a.amount) * 100) : 0;

  return (
    <Card
      className="border hover:shadow-md transition-all cursor-pointer group"
      onClick={onClick}
    >
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <p className="font-bold text-sm">{a.employeeName}</p>
              <span className="text-xs text-gray-400">{a.employeeCode}</span>
              <Badge className={`text-xs border ${s.cls}`}>{s.label}</Badge>
              {(a.overdueMonths?.length ?? 0) > 0 && (
                <span className="flex items-center gap-1 text-xs bg-red-50 text-red-600 border border-red-200 px-1.5 py-0.5 rounded-full">
                  <AlertTriangle size={9} />
                  {a.overdueMonths!.length} overdue
                </span>
              )}
            </div>
            {a.purpose && <p className="text-xs text-gray-500 mb-2">{a.purpose}</p>}
            <div className="grid grid-cols-3 gap-3 text-center mb-3">
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
                  <span>Recovery progress</span><span>{progress}%</span>
                </div>
                <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                  <div className="h-full bg-green-500 rounded-full" style={{ width: `${progress}%` }} />
                </div>
                {a.advanceType === "term" && a.emiAmount > 0 && (
                  <p className="text-xs text-gray-400 mt-1">
                    EMI: ₹{a.emiAmount.toLocaleString()}/month · Starts{" "}
                    {a.repaymentStartMonth ? MONTHS[a.repaymentStartMonth - 1] : ""} {a.repaymentStartYear}
                  </p>
                )}
              </div>
            )}
          </div>
          <ChevronRight size={16} className="text-gray-300 group-hover:text-gray-500 transition-colors shrink-0 mt-1" />
        </div>
      </CardContent>
    </Card>
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
  const [form, setForm] = useState({
    employeeCode: "", advanceType: "general",
    amount: "", purpose: "", emiAmount: "",
    repaymentStartMonth: new Date().getMonth() + 2,
    repaymentStartYear: new Date().getFullYear(),
  });

  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState<"all" | "general" | "term">("all");

  const { data: advances, isLoading } = useListAdvances();
  const { data: employees } = useListEmployees({ status: "active" });
  const createMutation = useCreateAdvance();
  const updateMutation = useUpdateAdvance();

  const allAdvances = advances ?? [];

  // Apply search + type filter
  const applyFilters = (list: Advance[]) => {
    const q = search.trim().toLowerCase();
    return list.filter(a => {
      const matchesSearch = !q ||
        a.employeeName.toLowerCase().includes(q) ||
        a.employeeCode.toLowerCase().includes(q) ||
        (a.purpose ?? "").toLowerCase().includes(q);
      const matchesType = filterType === "all" || a.advanceType === filterType;
      return matchesSearch && matchesType;
    });
  };

  const generalAdvances   = applyFilters(allAdvances.filter(a => a.advanceType === "general" && !["closed","rejected"].includes(a.status)));
  const termAdvances      = applyFilters(allAdvances.filter(a => a.advanceType === "term"    && !["closed","rejected"].includes(a.status)));
  const completedAdvances = applyFilters(allAdvances.filter(a => a.status === "closed"));
  const rejectedAdvances  = applyFilters(allAdvances.filter(a => a.status === "rejected"));

  const totalOutstanding = allAdvances
    .filter(a => a.status === "approved")
    .reduce((s, a) => s + a.outstanding, 0);
  const totalDisbursed = allAdvances
    .filter(a => a.status !== "rejected")
    .reduce((s, a) => s + a.amount, 0);
  const activeCount = allAdvances.filter(a => a.status === "approved").length;

  const updateStatus = async (id: number, status: Advance["status"]) => {
    try {
      await updateMutation.mutateAsync({ id, data: { status } as Partial<Advance> });
    } catch {
      toast({ title: "Failed to update advance", variant: "destructive" });
      return;
    }
    toast({ title: `Advance ${status}` });
    queryClient.invalidateQueries({ queryKey: getListAdvancesQueryKey() });
  };

  const createAdvance = async () => {
    if (!form.employeeCode || !form.amount) {
      toast({ title: "Employee code and amount are required", variant: "destructive" });
      return;
    }
    const employee = (employees ?? []).find(
      e => e.employeeCode.toLowerCase() === form.employeeCode.trim().toLowerCase(),
    );
    if (!employee) {
      toast({ title: `Employee "${form.employeeCode}" not found`, variant: "destructive" });
      return;
    }
    const amt = parseFloat(form.amount);
    const emi = parseFloat(form.emiAmount) || amt;
    try {
      await createMutation.mutateAsync({
        employeeId: employee.id,
        advanceType: form.advanceType,
        amount: amt,
        purpose: form.purpose,
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
    setForm({
      employeeCode: "", advanceType: "general", amount: "", purpose: "", emiAmount: "",
      repaymentStartMonth: new Date().getMonth() + 2,
      repaymentStartYear: new Date().getFullYear(),
    });
    queryClient.invalidateQueries({ queryKey: getListAdvancesQueryKey() });
  };

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

        {/* Summary Cards */}
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
          <div className="grid grid-cols-3 gap-4">
            {[
              { label: "Total Disbursed",   value: `₹${(totalDisbursed / 1000).toFixed(0)}K`,  color: "text-blue-700" },
              { label: "Total Outstanding", value: `₹${(totalOutstanding / 1000).toFixed(0)}K`, color: "text-red-600" },
              { label: "Active Advances",   value: activeCount,                                  color: "text-green-700" },
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

        {/* Search & Filter bar */}
        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative flex-1 min-w-48">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by name, employee code, or purpose…"
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
        <Tabs defaultValue="general">
          <TabsList className="bg-gray-100">
            <TabsTrigger value="general">General Advance ({generalAdvances.length})</TabsTrigger>
            <TabsTrigger value="term">Term Advance / Loan ({termAdvances.length})</TabsTrigger>
            <TabsTrigger value="completed">Completed ({completedAdvances.length})</TabsTrigger>
            <TabsTrigger value="rejected" className="data-[state=active]:bg-red-600 data-[state=active]:text-white">
              Rejected ({rejectedAdvances.length})
            </TabsTrigger>
          </TabsList>

          {/* General Advance */}
          <TabsContent value="general" className="mt-4 space-y-3">
            <p className="text-xs text-gray-500 bg-blue-50 border border-blue-100 p-3 rounded-lg">
              <strong>General Advance:</strong> Regular salary advances. Employee can repay the full outstanding amount at once or in parts.
            </p>
            {isLoading ? (
              Array.from({ length: 2 }).map((_, i) => (
                <Card key={i}><CardContent className="p-4">
                  <Skeleton className="h-5 w-40 mb-2" /><Skeleton className="h-4 w-64" />
                </CardContent></Card>
              ))
            ) : generalAdvances.length === 0 ? (
              <div className="text-center py-10 text-muted-foreground text-sm">No active general advances.</div>
            ) : (
              generalAdvances.map(a => (
                <AdvanceCard key={a.id} a={a} onClick={() => setSelectedId(a.id)} />
              ))
            )}
          </TabsContent>

          {/* Term Advance / Loan */}
          <TabsContent value="term" className="mt-4 space-y-3">
            <p className="text-xs text-gray-500 bg-purple-50 border border-purple-100 p-3 rounded-lg">
              <strong>Term Advance / Loan:</strong> Long-term personal loans with monthly EMI. Payments are tracked individually each month.
            </p>
            {isLoading ? (
              Array.from({ length: 2 }).map((_, i) => (
                <Card key={i}><CardContent className="p-4">
                  <Skeleton className="h-5 w-40 mb-2" /><Skeleton className="h-4 w-64" />
                </CardContent></Card>
              ))
            ) : termAdvances.length === 0 ? (
              <div className="text-center py-10 text-muted-foreground text-sm">No active term loans.</div>
            ) : (
              termAdvances.map(a => (
                <AdvanceCard key={a.id} a={a} onClick={() => setSelectedId(a.id)} />
              ))
            )}
          </TabsContent>

          {/* Completed */}
          <TabsContent value="completed" className="mt-4 space-y-3">
            <p className="text-xs text-gray-500 bg-green-50 border border-green-100 p-3 rounded-lg">
              <strong>Completed:</strong> Fully repaid advances and loans. Read-only history.
            </p>
            {isLoading ? (
              Array.from({ length: 2 }).map((_, i) => (
                <Card key={i}><CardContent className="p-4">
                  <Skeleton className="h-5 w-40 mb-2" /><Skeleton className="h-4 w-64" />
                </CardContent></Card>
              ))
            ) : completedAdvances.length === 0 ? (
              <div className="text-center py-10 text-muted-foreground text-sm">No completed settlements yet.</div>
            ) : (
              completedAdvances.map(a => (
                <AdvanceCard key={a.id} a={a} onClick={() => setSelectedId(a.id)} />
              ))
            )}
          </TabsContent>

          {/* Rejected */}
          <TabsContent value="rejected" className="mt-4 space-y-3">
            <p className="text-xs text-gray-500 bg-red-50 border border-red-100 p-3 rounded-lg">
              <strong>Rejected:</strong> Advance and loan requests that were declined by HR.
            </p>
            {isLoading ? (
              Array.from({ length: 2 }).map((_, i) => (
                <Card key={i}><CardContent className="p-4">
                  <Skeleton className="h-5 w-40 mb-2" /><Skeleton className="h-4 w-64" />
                </CardContent></Card>
              ))
            ) : rejectedAdvances.length === 0 ? (
              <div className="text-center py-10 text-muted-foreground text-sm">No rejected requests.</div>
            ) : (
              rejectedAdvances.map(a => (
                <AdvanceCard key={a.id} a={a} onClick={() => setSelectedId(a.id)} />
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
                <Label>Employee Code <span className="text-red-500">*</span></Label>
                <Input
                  value={form.employeeCode}
                  onChange={e => setForm(f => ({ ...f, employeeCode: e.target.value }))}
                  placeholder="e.g. EMP001"
                />
                <p className="text-xs text-muted-foreground">Enter the employee's code to look them up</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Advance Type</Label>
                  <select
                    value={form.advanceType}
                    onChange={e => setForm(f => ({ ...f, advanceType: e.target.value }))}
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
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <Label>EMI (₹/month)</Label>
                  <Input
                    type="number" value={form.emiAmount}
                    onChange={e => setForm(f => ({ ...f, emiAmount: e.target.value }))} placeholder="0"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Start Month</Label>
                  <select
                    value={form.repaymentStartMonth}
                    onChange={e => setForm(f => ({ ...f, repaymentStartMonth: Number(e.target.value) }))}
                    className="w-full h-9 rounded-md border px-3 text-sm bg-background"
                  >
                    {MONTHS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label>Start Year</Label>
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

        {/* Detail Drawer */}
        <AdvanceDetailDrawer
          advanceId={selectedId}
          open={selectedId !== null}
          onClose={() => setSelectedId(null)}
        />
      </div>
    </HrLayout>
  );
}
