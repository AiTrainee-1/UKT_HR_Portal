import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  useFactoryEmployeeRecord,
  useSetFactoryEmployeeStatus,
  useSetFactoryPayroll,
  useUpdateFactoryEmployee,
  type Branch,
  type FactoryEmployee,
  type FactoryEmployeeRecord,
} from "@/lib/api-client/custom-hooks";
import { moveConflict } from "../production-employees/logic";
import {
  CATEGORY_LABEL,
  categoryOf,
  editFormFrom,
  editPayrollBody,
  editProblems,
  errorText,
  firstProblem,
  frequencyText,
  payText,
  payrollToast,
  personalBody,
  recordFromRow,
  statusChanged,
  storedSplit,
  type EditField,
  type EditForm,
  type PayrollForm,
  type Rights,
} from "./logic";
import { PayrollFields } from "./PayrollFields";
import { Field, FormSection, LoadError, Lines, SELECT_CLASS, ViewOnlyNote } from "./parts";

type Common = {
  branches: Branch[];
  needsBranch: boolean;
  rights: Rights;
  onClose: () => void;
};

/**
 * Edit a factory employee from the page: personal details (the Edit Employee endpoint and its rights), the payroll
 * (category, frequency and salary or rate, through this page's payroll endpoint) and the status. The full form is one
 * link away.
 */
export function EditEmployeeSheet({
  row,
  focus,
  ...common
}: Common & { row: FactoryEmployee | null; focus: "salary" | null }) {
  const readable = common.rights.readEmployee;
  const record = useFactoryEmployeeRecord(row && readable ? row.id : null);
  return (
    <Sheet open={row !== null} onOpenChange={(o) => !o && common.onClose()}>
      <SheetContent className="w-full overflow-y-auto bg-gray-50 sm:max-w-xl" data-testid="fe-edit-sheet">
        {row && (
          <>
            <SheetHeader className="text-left">
              <SheetTitle className="pr-6">Edit {row.name}</SheetTitle>
              <SheetDescription>
                <span className="font-mono">{row.code}</span> · saved to the employee record.
              </SheetDescription>
            </SheetHeader>
            <div className="mt-4">
              {readable && record.isLoading ? (
                <div className="space-y-3" data-testid="fe-edit-loading">
                  <Skeleton className="h-32 rounded-2xl" />
                  <Skeleton className="h-40 rounded-2xl" />
                </div>
              ) : readable && (record.isError || !record.data) ? (
                <LoadError what="the employee" onRetry={() => void record.refetch()} />
              ) : (
                <EditFields
                  key={row.id}
                  row={row}
                  record={readable ? record.data! : recordFromRow(row)}
                  recordRead={readable}
                  focus={focus}
                  {...common}
                />
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function EditFields({
  row,
  record,
  recordRead,
  focus,
  branches,
  needsBranch,
  rights,
  onClose,
}: Common & { row: FactoryEmployee; record: FactoryEmployeeRecord; recordRead: boolean; focus: "salary" | null }) {
  const { toast } = useToast();
  const update = useUpdateFactoryEmployee();
  const payroll = useSetFactoryPayroll();
  const status = useSetFactoryEmployeeStatus();
  const before = useMemo(() => editFormFrom(record, row.productionPayCycle), [record, row.productionPayCycle]);
  // a login that cannot read the record has no split to compare with: only a new salary is sent (split by the server)
  const splitRecorded = recordRead ? storedSplit(record).recorded : true;
  const [form, setForm] = useState<EditForm>(before);
  const [submitted, setSubmitted] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  // the server asked for a reason (a worker who already has payroll changes cycle)
  const [conflict, setConflict] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const payRef = useRef<HTMLDivElement>(null);
  const opts = { needsBranch, personal: rights.editEmployee, payroll: rights.manage, splitRecorded };
  const problems = editProblems(form, before, opts);
  const shown = (k: EditField) => (submitted ? problems[k] : undefined);
  const busy = update.isPending || payroll.isPending || status.isPending;
  const notRecorded = recordRead && form.category === "staff" && !!record.salaryAmount && !storedSplit(record).recorded;

  useEffect(() => {
    if (focus === "salary") payRef.current?.scrollIntoView?.({ block: "center" });
  }, [focus]);

  const set = <K extends EditField>(k: K, v: EditForm[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setServerError(null);
  };
  const setPayrollPart = (patch: Partial<PayrollForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setServerError(null);
    setConflict(null);
  };

  const save = async () => {
    setSubmitted(true);
    const problem = firstProblem(problems);
    if (problem) {
      toast({ title: "Check the form", description: problem, variant: "destructive" });
      return;
    }
    const personal = rights.editEmployee ? personalBody(form, before, { sendBranch: needsBranch }) : null;
    const pay = rights.manage ? editPayrollBody(row.id, form, before, splitRecorded) : null;
    const changeStatus = rights.setStatus && statusChanged(form, before);
    if (!personal && !pay && !changeStatus) {
      onClose();
      return;
    }
    if (conflict && !reason.trim()) {
      toast({ title: "Give a reason", description: "A reason is needed for this move.", variant: "destructive" });
      return;
    }
    try {
      if (personal) await update.mutateAsync({ id: row.id, data: personal });
    } catch (e) {
      const message = errorText(e);
      setServerError(message);
      toast({ title: "The changes were not saved", description: message, variant: "destructive" });
      return;
    }
    let payLines: string[] = [];
    if (pay) {
      try {
        const result = await payroll.mutateAsync(
          conflict && reason.trim() ? { ...pay, confirm: true, reason: reason.trim() } : pay,
        );
        const words = payrollToast(result, form);
        if (result.updated.length === 0) {
          setServerError(result.refused[0]?.reason ?? words.title);
          toast({
            title: "The payroll was not changed",
            description: <Lines lines={words.lines} />,
            variant: "destructive",
          });
          return;
        }
        payLines = [words.title, ...words.lines];
        setConflict(null);
      } catch (e) {
        const facts = moveConflict(e);
        if (facts) {
          setConflict(facts[0]?.message ?? "This worker has already received salary on their pay cycle.");
          setReason("");
          return;
        }
        const message = errorText(e);
        setServerError(message);
        toast({
          title: personal ? "Saved, but the payroll was not changed" : "The payroll was not changed",
          description: message,
          variant: "destructive",
        });
        return;
      }
    }
    if (changeStatus) {
      const result = await status.mutateAsync({ ids: [row.id], status: form.status });
      if (result.failed.length) {
        toast({
          title: "Saved, but the status was not changed",
          description: errorText(result.failed[0].error),
          variant: "destructive",
        });
        return;
      }
    }
    toast({
      title: `${form.firstName.trim() || row.firstName} ${form.lastName.trim() || row.lastName} saved`,
      description: payLines.length ? <Lines lines={payLines} /> : undefined,
    });
    onClose();
  };

  return (
    <div className="space-y-4" data-testid="fe-edit-form">
      {serverError && (
        <p
          className="rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-800"
          role="alert"
          data-testid="fe-edit-error"
        >
          {serverError}
        </p>
      )}

      {rights.editEmployee ? (
        <FormSection title="Personal details">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="First name" htmlFor="fe-e-first" required error={shown("firstName")}>
              <Input
                id="fe-e-first"
                value={form.firstName}
                onChange={(e) => set("firstName", e.target.value)}
                data-testid="fe-e-first"
              />
            </Field>
            <Field label="Last name" htmlFor="fe-e-last" required error={shown("lastName")}>
              <Input
                id="fe-e-last"
                value={form.lastName}
                onChange={(e) => set("lastName", e.target.value)}
                data-testid="fe-e-last"
              />
            </Field>
            <Field label="Phone" htmlFor="fe-e-phone" required error={shown("phone")}>
              <Input
                id="fe-e-phone"
                inputMode="tel"
                value={form.phone}
                onChange={(e) => set("phone", e.target.value)}
                data-testid="fe-e-phone"
              />
            </Field>
            <Field label="Join date" htmlFor="fe-e-join" error={shown("joinDate")}>
              <Input
                id="fe-e-join"
                type="date"
                value={form.joinDate}
                onChange={(e) => set("joinDate", e.target.value)}
              />
            </Field>
            {needsBranch && (
              <Field label="Branch" htmlFor="fe-e-branch" required error={shown("branchId")}>
                <select
                  id="fe-e-branch"
                  className={SELECT_CLASS}
                  value={form.branchId}
                  onChange={(e) => set("branchId", e.target.value)}
                  data-testid="fe-e-branch"
                >
                  <option value="">Select a branch</option>
                  {branches.map((b) => (
                    <option key={b.id} value={String(b.id)}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
          </div>
        </FormSection>
      ) : (
        <ViewOnlyNote testId="fe-edit-personal-locked">
          Name, phone and join date are changed by roles that may edit employees.
        </ViewOnlyNote>
      )}

      {rights.setStatus && (
        <FormSection title="Status">
          <Field
            label="Status"
            htmlFor="fe-e-status"
            hint={form.status === "inactive" ? "Inactive employees are left out of attendance and payroll." : undefined}
          >
            <select
              id="fe-e-status"
              className={SELECT_CLASS}
              value={form.status}
              onChange={(e) => set("status", e.target.value === "inactive" ? "inactive" : "active")}
              data-testid="fe-e-status"
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </Field>
        </FormSection>
      )}

      <div ref={payRef}>
        <FormSection title="Payroll" testId="fe-edit-pay">
          {rights.manage ? (
            <PayrollFields
              form={form}
              onChange={setPayrollPart}
              problems={
                submitted || problems.payCycle
                  ? {
                      payCycle: problems.payCycle,
                      salaryAmount: shown("salaryAmount"),
                      salaryPerShift: shown("salaryPerShift"),
                      split: shown("split"),
                    }
                  : {}
              }
              testId="fe-e-pay"
              notRecorded={notRecorded}
              autoFocusAmount={focus === "salary"}
            />
          ) : (
            <p className="text-sm text-gray-700" data-testid="fe-edit-pay-readonly">
              {CATEGORY_LABEL[categoryOf(row)]} · {frequencyText(categoryOf(row), row.productionPayCycle)} ·{" "}
              {payText(row)}
            </p>
          )}
          {conflict && (
            <div
              className="space-y-1.5 rounded-xl border border-amber-200 bg-amber-50 p-3"
              data-testid="fe-edit-reason"
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
                placeholder="For example: moved to the weekly roster"
                aria-label="Reason for the move"
                data-testid="fe-edit-reason-text"
              />
            </div>
          )}
        </FormSection>
      </div>

      <div className="flex flex-col-reverse gap-2 pb-2 sm:flex-row sm:items-center sm:justify-between">
        <Link
          href={`/hr/employees/${row.id}/edit`}
          className="inline-flex items-center gap-1 text-xs font-semibold text-sky-700 hover:underline"
        >
          <ExternalLink size={12} /> Open the full edit form
        </Link>
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={busy} data-testid="fe-edit-save">
            {busy ? "Saving…" : conflict ? "Save with this reason" : "Save changes"}
          </Button>
        </div>
      </div>
    </div>
  );
}
