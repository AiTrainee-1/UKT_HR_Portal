import { useState } from "react";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  useListAdvances, useCreateAdvance, useUpdateAdvance,
  getListAdvancesQueryKey, Advance,
} from "@/lib/api-client";
import { useListEmployees } from "@/lib/api-client";
import { useQueryClient } from "@tanstack/react-query";
import { Wallet, Plus, IndianRupee, CheckCircle2, XCircle, TrendingDown } from "lucide-react";

const STATUS_CONFIG: Record<string, { label: string; cls: string }> = {
  pending:  { label: "Pending",  cls: "bg-amber-50 text-amber-700 border-amber-200" },
  approved: { label: "Approved", cls: "bg-green-50 text-green-700 border-green-200" },
  rejected: { label: "Rejected", cls: "bg-red-50 text-red-700 border-red-200" },
  closed:   { label: "Closed",   cls: "bg-gray-50 text-gray-700 border-gray-200" },
};

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

export default function Settlement() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [showDialog, setShowDialog] = useState(false);
  const [form, setForm] = useState({
    employeeCode: "", advanceType: "general",
    amount: "", purpose: "", emiAmount: "",
    repaymentStartMonth: new Date().getMonth() + 2,
    repaymentStartYear: new Date().getFullYear(),
  });

  const { data: advances, isLoading } = useListAdvances();
  const { data: employees } = useListEmployees({ status: "active" });
  const createMutation = useCreateAdvance();
  const updateMutation = useUpdateAdvance();

  const generalAdvances = (advances ?? []).filter((a) => a.advanceType === "general");
  const termAdvances = (advances ?? []).filter((a) => a.advanceType === "term");

  const totalOutstanding = (advances ?? [])
    .filter((a) => a.status === "approved")
    .reduce((s, a) => s + a.outstanding, 0);
  const totalDisbursed = (advances ?? [])
    .filter((a) => a.status !== "rejected")
    .reduce((s, a) => s + a.amount, 0);

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
      (e) => e.employeeCode.toLowerCase() === form.employeeCode.trim().toLowerCase(),
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
    queryClient.invalidateQueries({ queryKey: getListAdvancesQueryKey() });
  };

  function AdvanceCard({ a }: { a: Advance }) {
    const s = STATUS_CONFIG[a.status] ?? STATUS_CONFIG.pending;
    const progress = a.amount > 0 ? Math.round((a.totalRepaid / a.amount) * 100) : 0;
    return (
      <Card className="border hover:shadow-sm transition-shadow">
        <CardContent className="p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap mb-1">
                <p className="font-bold text-sm">{a.employeeName}</p>
                <span className="text-xs text-gray-400">{a.employeeCode}</span>
                <Badge className={`text-xs border ${s.cls}`}>{s.label}</Badge>
              </div>
              <p className="text-xs text-gray-500 mb-2">{a.purpose}</p>
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
                  <div className="flex items-center justify-between text-xs text-gray-400 mb-1">
                    <span>Recovery progress</span><span>{progress}%</span>
                  </div>
                  <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                    <div className="h-full bg-green-500 rounded-full transition-all" style={{ width: `${progress}%` }} />
                  </div>
                  <p className="text-xs text-gray-400 mt-1">
                    EMI: ₹{a.emiAmount.toLocaleString()}/month · Starts{" "}
                    {a.repaymentStartMonth ? MONTHS[a.repaymentStartMonth - 1] : ""} {a.repaymentStartYear}
                  </p>
                </div>
              )}
            </div>
            {a.status === "pending" && (
              <div className="flex flex-col gap-2 shrink-0">
                <Button size="sm" className="h-7 text-xs gap-1 bg-green-600 hover:bg-green-700"
                  onClick={() => updateStatus(a.id, "approved")}
                  disabled={updateMutation.isPending}>
                  <CheckCircle2 size={11} /> Approve
                </Button>
                <Button size="sm" variant="outline" className="h-7 text-xs gap-1 text-red-500 border-red-200"
                  onClick={() => updateStatus(a.id, "rejected")}
                  disabled={updateMutation.isPending}>
                  <XCircle size={11} /> Reject
                </Button>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <HrLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-black text-gray-900">Settlement</h2>
            <p className="text-muted-foreground text-sm mt-0.5">Manage general advances and term loans</p>
          </div>
          <Button className="gap-2" onClick={() => setShowDialog(true)}>
            <Plus size={15} /> New Advance
          </Button>
        </div>

        {/* Summary */}
        {isLoading ? (
          <div className="grid grid-cols-3 gap-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <Card key={i} className="border-0 shadow-sm">
                <CardContent className="p-4">
                  <Skeleton className="h-3 w-24 mb-2" />
                  <Skeleton className="h-6 w-20" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-4">
            {[
              { label: "Total Disbursed",  value: `₹${(totalDisbursed / 1000).toFixed(0)}K`,  color: "text-blue-700" },
              { label: "Total Outstanding",value: `₹${(totalOutstanding / 1000).toFixed(0)}K`, color: "text-red-600" },
              { label: "Active Advances",  value: (advances ?? []).filter((a) => a.status === "approved").length, color: "text-green-700" },
            ].map((s) => (
              <Card key={s.label} className="border-0 shadow-sm">
                <CardContent className="p-4">
                  <p className="text-xs text-muted-foreground font-medium">{s.label}</p>
                  <p className={`text-xl font-black mt-0.5 ${s.color}`}>{s.value}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        <Tabs defaultValue="general">
          <TabsList className="bg-gray-100">
            <TabsTrigger value="general">General Advance ({generalAdvances.length})</TabsTrigger>
            <TabsTrigger value="term">Term Advance / Loan ({termAdvances.length})</TabsTrigger>
          </TabsList>
          <TabsContent value="general" className="mt-4 space-y-3">
            <p className="text-xs text-gray-500 bg-blue-50 border border-blue-100 p-3 rounded-lg">
              <strong>General Advance:</strong> Regular salary advances recovered through monthly salary deductions.
            </p>
            {isLoading ? (
              Array.from({ length: 2 }).map((_, i) => (
                <Card key={i} className="border-0 shadow-sm">
                  <CardContent className="p-4">
                    <Skeleton className="h-5 w-40 mb-2" /><Skeleton className="h-4 w-64" />
                  </CardContent>
                </Card>
              ))
            ) : generalAdvances.length === 0 ? (
              <div className="text-center py-10 text-muted-foreground text-sm">No general advances yet.</div>
            ) : (
              generalAdvances.map((a) => <AdvanceCard key={a.id} a={a} />)
            )}
          </TabsContent>
          <TabsContent value="term" className="mt-4 space-y-3">
            <p className="text-xs text-gray-500 bg-purple-50 border border-purple-100 p-3 rounded-lg">
              <strong>Term Advance / Loan:</strong> Special personal loans provided by HR — not a salary advance. Long-term recovery with EMI.
            </p>
            {isLoading ? (
              Array.from({ length: 2 }).map((_, i) => (
                <Card key={i} className="border-0 shadow-sm">
                  <CardContent className="p-4">
                    <Skeleton className="h-5 w-40 mb-2" /><Skeleton className="h-4 w-64" />
                  </CardContent>
                </Card>
              ))
            ) : termAdvances.length === 0 ? (
              <div className="text-center py-10 text-muted-foreground text-sm">No term advances yet.</div>
            ) : (
              termAdvances.map((a) => <AdvanceCard key={a.id} a={a} />)
            )}
          </TabsContent>
        </Tabs>

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
                  onChange={(e) => setForm((f) => ({ ...f, employeeCode: e.target.value }))}
                  placeholder="e.g. EMP001"
                />
                <p className="text-xs text-muted-foreground">Enter the employee's code to look them up</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Advance Type</Label>
                  <select value={form.advanceType} onChange={(e) => setForm((f) => ({ ...f, advanceType: e.target.value }))}
                    className="w-full h-9 rounded-md border px-3 text-sm bg-background">
                    <option value="general">General Advance</option>
                    <option value="term">Term Advance (Loan)</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label>Amount (₹) <span className="text-red-500">*</span></Label>
                  <Input type="number" value={form.amount}
                    onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} placeholder="0" />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Purpose</Label>
                <Input value={form.purpose}
                  onChange={(e) => setForm((f) => ({ ...f, purpose: e.target.value }))} placeholder="Reason for advance" />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <Label>EMI (₹/month)</Label>
                  <Input type="number" value={form.emiAmount}
                    onChange={(e) => setForm((f) => ({ ...f, emiAmount: e.target.value }))} placeholder="0" />
                </div>
                <div className="space-y-1.5">
                  <Label>Start Month</Label>
                  <select value={form.repaymentStartMonth}
                    onChange={(e) => setForm((f) => ({ ...f, repaymentStartMonth: Number(e.target.value) }))}
                    className="w-full h-9 rounded-md border px-3 text-sm bg-background">
                    {MONTHS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label>Start Year</Label>
                  <Input type="number" value={form.repaymentStartYear}
                    onChange={(e) => setForm((f) => ({ ...f, repaymentStartYear: Number(e.target.value) }))} />
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
      </div>
    </HrLayout>
  );
}
