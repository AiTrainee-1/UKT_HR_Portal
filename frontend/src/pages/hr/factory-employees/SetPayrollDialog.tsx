import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useSetFactoryPayroll, type FactoryEmployee } from "@/lib/api-client/custom-hooks";
import { EMPTY_SPLIT } from "@/lib/salary-split";
import { moveConflict } from "../production-employees/logic";
import {
  categoriesIn,
  employees,
  errorText,
  firstProblem,
  payrollBody,
  payrollProblems,
  payrollToast,
  type PayrollForm,
} from "./logic";
import { Lines } from "./parts";
import { PayrollFields } from "./PayrollFields";

/** The form a Set payroll starts from: everyone's category and frequency when they share one. */
function startForm(rows: FactoryEmployee[]): PayrollForm {
  const kinds = categoriesIn(rows);
  const category = kinds.length === 1 ? kinds[0] : "staff";
  const cycles = new Set(rows.map((r) => r.productionPayCycle));
  const cycle = category === "production" && cycles.size === 1 ? ([...cycles][0] ?? "") : "";
  return { category, payCycle: cycle, salaryAmount: "", split: EMPTY_SPLIT, salaryPerShift: "" };
}

/**
 * Put one or many factory employees in Staff Payroll (Monthly) or Production Payroll on a frequency (Weekly, BiWeekly
 * or Monthly, required), optionally with a new salary or rate for all of them. A worker who already has payroll moves
 * between cycles only with a reason (the server asks).
 */
export function SetPayrollDialog({ rows, onClose }: { rows: FactoryEmployee[]; onClose: () => void }) {
  const { toast } = useToast();
  const save = useSetFactoryPayroll();
  const [form, setForm] = useState<PayrollForm>(() => startForm(rows));
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const problems = payrollProblems(form, { amountRequired: false, withSplit: false });
  const one = rows.length === 1 ? rows[0] : null;

  const change = (patch: Partial<PayrollForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setError(null);
    setConflict(null);
  };

  const run = async () => {
    setSubmitted(true);
    const problem = firstProblem(problems);
    if (problem) return;
    if (conflict && !reason.trim()) return;
    const body = payrollBody(
      rows.map((r) => r.id),
      form,
      { withSplit: false },
    );
    try {
      const result = await save.mutateAsync(conflict ? { ...body, confirm: true, reason: reason.trim() } : body);
      const words = payrollToast(result, form);
      toast({
        title: words.title,
        description: words.lines.length ? <Lines lines={words.lines} /> : undefined,
        variant: words.failed ? "destructive" : undefined,
      });
      onClose();
    } catch (e) {
      const facts = moveConflict(e);
      if (facts) {
        const names = facts.map((f) => f.name).filter(Boolean);
        setConflict(
          facts.length === 1
            ? (facts[0].message ?? `${names[0]} has already received salary on their pay cycle.`)
            : `${employees(facts.length)} have already received salary on their pay cycle: ${names.join(", ")}.`,
        );
        setReason("");
        return;
      }
      setError(errorText(e));
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent
        className="flex max-h-[92vh] w-[calc(100%-1.5rem)] max-w-2xl flex-col gap-0 overflow-hidden p-0"
        data-testid="fe-payroll-dialog"
      >
        <DialogHeader className="border-b bg-gradient-to-br from-amber-50 via-white to-blue-50/60 px-5 py-4 pr-14">
          <DialogTitle className="text-lg font-black">
            {one ? `Payroll of ${one.name}` : `Set payroll for ${employees(rows.length)}`}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Staff Payroll pays a monthly salary every month. Production Payroll pays per shift on the frequency chosen,
            on that frequency&apos;s Production Payroll page.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-5">
          {error && (
            <p
              className="rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-800"
              role="alert"
              data-testid="fe-payroll-error"
            >
              {error}
            </p>
          )}
          <PayrollFields
            form={form}
            onChange={change}
            problems={submitted ? problems : {}}
            testId="fe-p"
            withSplit={false}
            amountOptional
          />
          {conflict && (
            <div
              className="space-y-1.5 rounded-xl border border-amber-200 bg-amber-50 p-3"
              data-testid="fe-payroll-reason"
            >
              <p className="text-sm font-semibold text-amber-900">{conflict}</p>
              <p className="text-xs text-amber-800">
                The salary already paid will not be paid again. Give a short reason for the move; it is kept in their
                history.
              </p>
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={500}
                rows={2}
                aria-label="Reason for the move"
                data-testid="fe-payroll-reason-text"
              />
            </div>
          )}
        </div>
        <div className="flex flex-col-reverse gap-2 border-t bg-white px-5 py-3 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => void run()}
            disabled={save.isPending || (!!conflict && !reason.trim())}
            data-testid="fe-payroll-save"
          >
            {save.isPending ? "Saving…" : conflict ? "Save with this reason" : "Save payroll"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
