import { useState } from "react";
import { CheckCircle2, Clock, Edit, Layers, Search } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DataPagination } from "@/components/ui/DataPagination";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { STATUS_CONFIG } from "@/components/payroll/BreakdownDrawer";
import { useToast } from "@/hooks/use-toast";
import { useUpdatePayrollRecord } from "@/lib/api-client";
import { useListProductionPayroll, type PayCycle, type ProductionPayrollItem } from "@/lib/api-client/custom-hooks";
import { rupees } from "./logic";

const adjustmentSchema = z.object({
  bonus: z.string().min(1, "Bonus amount required"),
  deductions: z.string().min(1, "Deduction amount required"),
  notes: z.string().optional(),
});

const PAGE_SIZE = 10;

/**
 * Salary tab of a cycle page: every payslip of the cycle, across periods, with the bonus / deduction adjustment and
 * "Mark Paid". Rows follow the cycle they were generated on.
 */
export function SalaryTab({ cycle }: { cycle: PayCycle }) {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [selected, setSelected] = useState<ProductionPayrollItem | null>(null);
  const { data: runs, isLoading } = useListProductionPayroll({
    cycle,
    limit: 500,
    status: statusFilter === "all" ? undefined : statusFilter,
  });
  const updateMutation = useUpdatePayrollRecord();

  const form = useForm<z.infer<typeof adjustmentSchema>>({
    resolver: zodResolver(adjustmentSchema),
    defaultValues: { bonus: "0", deductions: "0", notes: "" },
  });

  const filtered = (runs ?? []).filter((r) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return r.employeeName?.toLowerCase().includes(q) || r.employeeCode?.toLowerCase().includes(q);
  });

  const totalGross = filtered.reduce((sum, r) => sum + r.grossSalary, 0);
  const totalPaid = filtered.filter((r) => r.status === "paid").reduce((sum, r) => sum + r.finalSalary, 0);
  const totalPending = filtered.filter((r) => r.status === "pending").reduce((sum, r) => sum + r.finalSalary, 0);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = page > totalPages ? totalPages : page;
  const paginated = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

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
    form.reset({ bonus: String(r.bonus), deductions: String(r.deductions), notes: r.notes ?? "" });
    setAdjustOpen(true);
  };

  const submitAdjustment = async (data: z.infer<typeof adjustmentSchema>) => {
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
    <div className="space-y-4" data-testid="pcp-salary-tab">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search employee…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="h-8 w-56 pl-8 text-sm"
          />
        </div>
        <Select
          value={statusFilter}
          onValueChange={(v) => {
            setStatusFilter(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="h-8 w-36 text-sm">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="paid">Paid</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card className="border-l-4 border-l-indigo-600 bg-white shadow-sm">
          <CardContent className="flex items-center justify-between p-5">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Gross Payroll Amount
              </p>
              <h3 className="mt-1 text-2xl font-black text-slate-900">{rupees(totalGross)}</h3>
            </div>
            <div className="rounded-xl bg-indigo-50 p-3 text-indigo-600">
              <Layers size={22} />
            </div>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-emerald-500 bg-white shadow-sm">
          <CardContent className="flex items-center justify-between p-5">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Paid Payroll</p>
              <h3 className="mt-1 text-2xl font-black text-slate-900">{rupees(totalPaid)}</h3>
            </div>
            <div className="rounded-xl bg-emerald-50 p-3 text-emerald-600">
              <CheckCircle2 size={22} />
            </div>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-amber-500 bg-white shadow-sm">
          <CardContent className="flex items-center justify-between p-5">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Pending Release</p>
              <h3 className="mt-1 text-2xl font-black text-slate-900">{rupees(totalPending)}</h3>
            </div>
            <div className="rounded-xl bg-amber-50 p-3 text-amber-600">
              <Clock size={22} />
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-3 py-2 text-left font-semibold text-gray-600">Employee</th>
              <th className="px-3 py-2 text-left font-semibold text-gray-600">Period</th>
              <th className="px-3 py-2 text-left font-semibold text-gray-600">Shifts</th>
              <th className="px-3 py-2 text-left font-semibold text-gray-600">Gross</th>
              <th className="px-3 py-2 text-left font-semibold text-gray-600">Bonus / Deduct</th>
              <th className="px-3 py-2 text-left font-semibold text-gray-600">Net</th>
              <th className="px-3 py-2 text-left font-semibold text-gray-600">Status</th>
              <th className="px-3 py-2 text-right font-semibold text-gray-600">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}>
                  <td colSpan={8} className="px-3 py-2">
                    <Skeleton className="h-6 w-full" />
                  </td>
                </tr>
              ))
            ) : paginated.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-10 text-center text-xs text-muted-foreground">
                  No salary records for this cycle and filter.
                </td>
              </tr>
            ) : (
              paginated.map((r) => {
                const s = STATUS_CONFIG[r.status] ?? STATUS_CONFIG.pending;
                return (
                  <tr key={r.id} className="hover:bg-gray-50/50" data-testid={`pcp-salary-row-${r.id}`}>
                    <td className="px-3 py-2">
                      <p className="font-semibold text-gray-900">{r.employeeName ?? r.employeeCode}</p>
                      <p className="font-mono text-xs text-muted-foreground">{r.employeeCode}</p>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {r.periodStart} – {r.periodEnd}
                    </td>
                    <td className="px-3 py-2">{r.presentDays}</td>
                    <td className="px-3 py-2">{rupees(r.grossSalary)}</td>
                    <td className="px-3 py-2 text-xs">
                      <span className="font-semibold text-emerald-600">+₹{r.bonus}</span>
                      <span className="ml-2 font-semibold text-rose-600">-₹{r.deductions}</span>
                    </td>
                    <td className="px-3 py-2 font-bold text-green-700">{rupees(r.finalSalary)}</td>
                    <td className="px-3 py-2">
                      <Badge className={`border text-xs ${s.cls}`}>{s.label}</Badge>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="inline-flex items-center gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 text-indigo-600 hover:text-indigo-800"
                          title="Adjust this payslip"
                          aria-label={`Edit the adjustment for ${r.employeeName ?? r.employeeCode}`}
                          onClick={() => openAdjust(r)}
                        >
                          <Edit size={13} />
                        </Button>
                        {r.status === "pending" && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 gap-1 text-xs"
                            onClick={() => markPaid(r.id, r.employeeName)}
                          >
                            <CheckCircle2 size={11} /> Mark Paid
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <DataPagination
        page={currentPage}
        totalPages={totalPages}
        totalItems={filtered.length}
        pageSize={PAGE_SIZE}
        onPageChange={setPage}
        className="rounded-lg border-t bg-card px-4 shadow-sm"
      />

      <Dialog open={adjustOpen} onOpenChange={setAdjustOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Adjust Employee Payroll</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(submitAdjustment)} className="space-y-4">
              <div className="mb-2 rounded-lg border bg-slate-50 p-3 text-xs">
                <strong>Employee:</strong> {selected?.employeeName} <br />
                <strong>Period:</strong> {selected?.periodStart} – {selected?.periodEnd} <br />
                <strong>Gross Salary:</strong> ₹{selected?.grossSalary}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <FormField
                  control={form.control}
                  name="bonus"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Bonus (₹)</FormLabel>
                      <FormControl>
                        <Input type="number" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="deductions"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Deductions (₹)</FormLabel>
                      <FormControl>
                        <Input type="number" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <FormField
                control={form.control}
                name="notes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Notes / Adjustments justification</FormLabel>
                    <FormControl>
                      <Textarea rows={2} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setAdjustOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" className="bg-amber-600 hover:bg-amber-700">
                  Apply Changes
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
