import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Info, Loader2, Scale } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useUpdatePayrollRecord } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { inr2 } from "./kit/format";

// One adjustment dialog for the Salary tabs of both payroll pages: HR can correct the bonus and the total deductions of a
// payslip. The server recomputes the net as gross + bonus - deductions (PATCH /api/payroll/:id), so the live "Net payable"
// below is the same sum.

const schema = z.object({
  bonus: z
    .string()
    .min(1, "Bonus amount required")
    .refine((v) => Number.isFinite(Number(v)) && Number(v) >= 0, "Enter zero or a positive amount"),
  deductions: z
    .string()
    .min(1, "Deduction amount required")
    .refine((v) => Number.isFinite(Number(v)) && Number(v) >= 0, "Enter zero or a positive amount"),
  notes: z.string().optional(),
});

export type AdjustTarget = {
  id: number;
  employeeName?: string | null;
  employeeCode?: string | null;
  /** "October 2026" or "2 Feb - 8 Feb 2026". */
  periodLabel: string;
  grossSalary: number;
  otAmount?: number | null;
  bonus: number;
  deductions: number;
  finalSalary: number;
  notes?: string | null;
};

const ACCENT = {
  indigo: {
    button: "bg-indigo-600 hover:bg-indigo-700",
    icon: "text-indigo-600",
    note: "bg-indigo-50 text-indigo-900 border-indigo-100",
  },
  amber: {
    button: "bg-amber-600 hover:bg-amber-700",
    icon: "text-amber-600",
    note: "bg-amber-50 text-amber-900 border-amber-100",
  },
} as const;

export function AdjustPayrollDialog({
  target,
  accent,
  onClose,
  onApplied,
}: {
  target: AdjustTarget | null;
  accent: "indigo" | "amber";
  onClose: () => void;
  onApplied?: () => void;
}) {
  const { toast } = useToast();
  const update = useUpdatePayrollRecord();
  const colors = ACCENT[accent];
  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { bonus: "0", deductions: "0", notes: "" },
  });

  useEffect(() => {
    if (target) {
      form.reset({ bonus: String(target.bonus), deductions: String(target.deductions), notes: target.notes ?? "" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.id]);

  const bonus = Number(form.watch("bonus")) || 0;
  const deductions = Number(form.watch("deductions")) || 0;
  const net = target ? Math.round((target.grossSalary + bonus - deductions) * 100) / 100 : 0;
  const changed = !!target && (bonus !== target.bonus || deductions !== target.deductions);

  const submit = async (data: z.infer<typeof schema>) => {
    if (!target) return;
    try {
      await update.mutateAsync({
        id: target.id,
        data: { bonus: Number(data.bonus), deductions: Number(data.deductions), notes: data.notes },
      });
      toast({ title: "Adjustment applied successfully" });
      onApplied?.();
      onClose();
    } catch (err) {
      toast({
        title: "Adjustment failed",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    }
  };

  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg" data-testid="adjust-payroll-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Scale size={16} className={colors.icon} /> Adjust Employee Payroll
          </DialogTitle>
          <DialogDescription>
            {target?.employeeName ?? target?.employeeCode} · {target?.periodLabel}
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(submit)} className="space-y-4">
            <div className="grid grid-cols-3 gap-2 text-center">
              {[
                { label: "Gross earned", value: inr2(target?.grossSalary), cls: "bg-blue-50 text-blue-800" },
                { label: "Overtime", value: inr2(target?.otAmount ?? 0), cls: "bg-slate-50 text-slate-700" },
                { label: "Computed net", value: inr2(target?.finalSalary), cls: "bg-green-50 text-green-800" },
              ].map((s) => (
                <div key={s.label} className={cn("rounded-xl p-2.5", s.cls)}>
                  <p className="text-[11px] font-medium opacity-70">{s.label}</p>
                  <p className="text-sm font-black tabular-nums">{s.value}</p>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="bonus"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Bonus (₹)</FormLabel>
                    <FormControl>
                      <Input type="number" min={0} step="0.01" {...field} />
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
                      <Input type="number" min={0} step="0.01" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <p className={cn("flex items-start gap-2 rounded-lg border px-3 py-2 text-xs", colors.note)}>
              <Info size={13} className="mt-0.5 shrink-0" />
              Deductions is the whole deduction on this payslip (PF, ESI, advance recovery, late deduction and anything
              you add). Net payable = gross earned + bonus − deductions.
            </p>

            <div
              className="flex items-center justify-between rounded-xl bg-gradient-to-r from-green-50 to-emerald-50 px-4 py-3"
              data-testid="adjust-net-preview"
            >
              <div>
                <p className="text-xs font-medium text-green-700">Net payable after this adjustment</p>
                {changed && <p className="text-[11px] text-green-700/70">was {inr2(target?.finalSalary)}</p>}
              </div>
              <p className={cn("text-xl font-black tabular-nums", net < 0 ? "text-red-700" : "text-green-800")}>
                {inr2(net)}
              </p>
            </div>

            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Notes / Adjustments justification</FormLabel>
                  <FormControl>
                    <Textarea rows={2} placeholder="Why the payslip is being adjusted" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" className={cn("gap-2 text-white", colors.button)} disabled={update.isPending}>
                {update.isPending && <Loader2 size={14} className="animate-spin" />} Apply Changes
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
