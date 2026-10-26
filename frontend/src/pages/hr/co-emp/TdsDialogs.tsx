import { useEffect, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useAddTdsEmployee, useUpdateTdsPercent, type TdsEmployeeRow } from "@/lib/api-client/custom-hooks";
import {
  addedMessage,
  checkTdsForm,
  formatPercent,
  parsePercent,
  serverProblem,
  tdsProblemField,
  type TdsForm,
} from "./logic";

const NO_FORM: TdsForm = { code: "", percent: "" };

/** A message under a field; announced to screen readers when it appears. */
function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-xs font-medium text-red-600" data-testid={id}>
      {message}
    </p>
  );
}

/**
 * Add an employee to TDS: the employee code and the percentage. A Co Emp employee is moved out of Co Emp (PF/ESI) by the
 * server in the same step; the toast says whether that happened. The server's own messages (unknown code, inactive,
 * already in TDS, a bad percentage) are shown in the dialog, which stays open so the entry can be corrected.
 */
export function AddTdsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { toast } = useToast();
  const add = useAddTdsEmployee();
  const [form, setForm] = useState<TdsForm>(NO_FORM);
  const [errors, setErrors] = useState<{ code?: string; percent?: string; form?: string }>({});

  useEffect(() => {
    if (open) {
      setForm(NO_FORM);
      setErrors({});
    }
  }, [open]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const check = checkTdsForm(form);
    if (!check.ok) {
      setErrors(check.errors);
      return;
    }
    setErrors({});
    try {
      const result = await add.mutateAsync({ employeeCode: check.employeeCode, percent: check.percent });
      toast(addedMessage(result));
      onOpenChange(false);
    } catch (err) {
      const problem = serverProblem(err);
      setErrors({ [tdsProblemField(problem)]: problem.message });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !add.isPending && onOpenChange(next)}>
      <DialogContent className="max-w-md" data-testid="tds-add-dialog">
        <form onSubmit={(e) => void submit(e)} className="grid gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>Add employee to TDS</DialogTitle>
            <DialogDescription>
              TDS is deducted from the employee&apos;s earned pay at this percentage. An employee who is in Co Emp
              (PF/ESI) is moved out of it and into TDS.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-1.5">
            <Label htmlFor="tds-add-code">Employee code</Label>
            <Input
              id="tds-add-code"
              value={form.code}
              onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
              autoComplete="off"
              autoFocus
              aria-invalid={errors.code ? true : undefined}
              aria-describedby={errors.code ? "tds-add-code-error" : undefined}
              data-testid="tds-add-code"
            />
            <FieldError id="tds-add-code-error" message={errors.code} />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="tds-add-percent">TDS percentage</Label>
            <div className="relative">
              <Input
                id="tds-add-percent"
                value={form.percent}
                onChange={(e) => setForm((f) => ({ ...f, percent: e.target.value }))}
                inputMode="decimal"
                autoComplete="off"
                placeholder="e.g. 10"
                className="pr-8"
                aria-invalid={errors.percent ? true : undefined}
                aria-describedby={errors.percent ? "tds-add-percent-error" : undefined}
                data-testid="tds-add-percent"
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                %
              </span>
            </div>
            <FieldError id="tds-add-percent-error" message={errors.percent} />
          </div>

          <FieldError id="tds-add-form-error" message={errors.form} />

          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={add.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={add.isPending} data-testid="tds-add-submit">
              {add.isPending && <Loader2 size={14} className="mr-2 animate-spin" />}
              Add to TDS
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Changes the TDS percentage of one employee. Closed when `row` is null. */
export function EditTdsPercentDialog({ row, onClose }: { row: TdsEmployeeRow | null; onClose: () => void }) {
  const { toast } = useToast();
  const update = useUpdateTdsPercent();
  const [percent, setPercent] = useState("");
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (row) {
      setPercent(row.tdsPercent == null ? "" : formatPercent(row.tdsPercent));
      setError(undefined);
    }
  }, [row]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!row) return;
    const check = parsePercent(percent);
    if (!check.ok) {
      setError(check.message);
      return;
    }
    setError(undefined);
    try {
      await update.mutateAsync({ employeeId: row.id, percent: check.value });
      toast({
        title: `${row.employeeCode} TDS changed to ${formatPercent(check.value)}%`,
        description: `${row.name} was at ${formatPercent(row.tdsPercent)}%. It applies from the next payroll.`,
      });
      onClose();
    } catch (err) {
      setError(serverProblem(err).message);
    }
  };

  return (
    <Dialog open={row !== null} onOpenChange={(next) => !next && !update.isPending && onClose()}>
      <DialogContent className="max-w-sm" data-testid="tds-edit-dialog">
        <form onSubmit={(e) => void submit(e)} className="grid gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>Edit TDS percentage</DialogTitle>
            <DialogDescription>
              {row ? `${row.employeeCode} · ${row.name}` : null}. Payroll generated from now on uses the new percentage;
              payroll already generated is not changed.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-1.5">
            <Label htmlFor="tds-edit-percent">TDS percentage</Label>
            <div className="relative">
              <Input
                id="tds-edit-percent"
                value={percent}
                onChange={(e) => setPercent(e.target.value)}
                inputMode="decimal"
                autoComplete="off"
                autoFocus
                className="pr-8"
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "tds-edit-percent-error" : undefined}
                data-testid="tds-edit-percent"
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                %
              </span>
            </div>
            <FieldError id="tds-edit-percent-error" message={error} />
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" onClick={onClose} disabled={update.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={update.isPending} data-testid="tds-edit-submit">
              {update.isPending && <Loader2 size={14} className="mr-2 animate-spin" />}
              Save percentage
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
