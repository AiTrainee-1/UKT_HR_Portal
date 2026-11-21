import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { CheckCircle2, UserPlus, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import {
  useApplyFactoryShift,
  useCreateFactoryEmployee,
  usePayrollSettings,
  useSetFactoryPayroll,
  type Branch,
  type FactoryEmployee,
  type FactoryLabel,
  type FactoryShiftGroup,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { todayIso } from "../shifts/shift-logic";
import {
  LABEL_IS_DEPARTMENT,
  PAY_CYCLE_LABEL,
  allStepsOk,
  createBody,
  createProblems,
  emptyCreateForm,
  errorText,
  firstProblem,
  payrollBody,
  shiftBody,
  shiftsFor,
  sortLabels,
  type CreateField,
  type CreateForm,
  type PayrollForm,
  type StepResult,
} from "./logic";
import { PayrollFields } from "./PayrollFields";
import { Field, FormSection, SELECT_CLASS } from "./parts";

type Props = {
  labels: FactoryLabel[];
  branches: Branch[];
  /** The existing shifts (shifts are created on Manage Shifts, not here). */
  shifts: FactoryShiftGroup[];
  /** An unscoped login picks the branch; a branch login's own is used. */
  needsBranch: boolean;
  /** The label tab the page is on: a new employee starts with it. */
  defaultLabelId: string;
  onClose: () => void;
  onOpenProfile: (row: FactoryEmployee) => void;
};

/**
 * A new factory employee: personal details, the label, branch and join date, the payroll (Staff Payroll: Monthly, a
 * monthly salary with its 50% + 50% split; Production Payroll: a salary per shift and the frequency, which is required),
 * an existing shift and the bank. Saved as the employee first, then (production) the frequency through the payroll
 * endpoint and (when chosen) the shift; each step's outcome is shown, so a later step that fails never hides a created
 * employee.
 */
export function CreateEmployeeDialog(p: Props) {
  const { toast } = useToast();
  const create = useCreateFactoryEmployee();
  const setPayroll = useSetFactoryPayroll();
  const applyShift = useApplyFactoryShift();
  const settings = usePayrollSettings();
  const [form, setForm] = useState<CreateForm>(() => emptyCreateForm(todayIso(), p.defaultLabelId));
  const [submitted, setSubmitted] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ row: FactoryEmployee; steps: StepResult[] } | null>(null);
  const topRef = useRef<HTMLDivElement>(null);

  const problems = useMemo(() => createProblems(form, p.needsBranch), [form, p.needsBranch]);
  const shown = (k: CreateField) => (submitted ? problems[k] : undefined);
  const production = form.category === "production";
  const offeredShifts = shiftsFor(p.shifts, form.category);

  const set = <K extends CreateField>(k: K, v: CreateForm[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setServerError(null);
  };
  const setPayrollPart = (patch: Partial<PayrollForm>) => {
    setForm((f) => {
      const next = { ...f, ...patch };
      // a shift of the other kind cannot be given: it is dropped when the category changes
      return patch.category && patch.category !== f.category ? { ...next, shiftId: "", saturdayOff: false } : next;
    });
    setServerError(null);
  };

  // Production: the configured default rate is filled in once per switch (as on Add Employee), still editable
  const defaultRate = settings.data?.defaultSalaryPerShift;
  const prefilled = useRef(false);
  useEffect(() => {
    if (form.category !== "production") {
      prefilled.current = false;
      return;
    }
    if (prefilled.current || !defaultRate) return;
    prefilled.current = true;
    setForm((f) => (f.salaryPerShift ? f : { ...f, salaryPerShift: String(defaultRate) }));
  }, [form.category, defaultRate]);

  const submit = async () => {
    setSubmitted(true);
    const problem = firstProblem(problems);
    if (problem) {
      toast({ title: "Check the form", description: problem, variant: "destructive" });
      return;
    }
    setBusy(true);
    let row: FactoryEmployee;
    try {
      row = await create.mutateAsync(createBody(form));
    } catch (e) {
      const message = errorText(e);
      setServerError(message);
      setBusy(false);
      topRef.current?.scrollIntoView?.({ block: "start" });
      toast({ title: "The employee was not created", description: message, variant: "destructive" });
      return;
    }
    const steps: StepResult[] = [
      {
        key: "create",
        ok: true,
        title: `${row.name} created as a factory employee`,
        detail: row.warnings?.join(" ") || null,
      },
    ];
    if (production && form.payCycle) {
      const label = `Production Payroll (${PAY_CYCLE_LABEL[form.payCycle]})`;
      try {
        const result = await setPayroll.mutateAsync(payrollBody([row.id], form, { withSplit: false }));
        steps.push(
          result.refused.length === 0
            ? { key: "payroll", ok: true, title: `Paid in ${label}`, detail: null }
            : { key: "payroll", ok: false, title: `Not put in ${label}`, detail: result.refused[0].reason },
        );
      } catch (e) {
        steps.push({ key: "payroll", ok: false, title: `Not put in ${label}`, detail: errorText(e) });
      }
    }
    if (form.shiftId) {
      const shiftName = p.shifts.find((s) => String(s.id) === form.shiftId)?.name ?? "the shift";
      try {
        const result = await applyShift.mutateAsync(
          shiftBody([row.id], Number(form.shiftId), form.shiftFrom, form.category === "staff" && form.saturdayOff),
        );
        const assigned = result.applied?.assigned ?? 0;
        steps.push(
          assigned > 0 || result.applied?.unchanged
            ? { key: "shift", ok: true, title: `On ${shiftName} from ${form.shiftFrom}`, detail: null }
            : {
                key: "shift",
                ok: false,
                title: `Not put on ${shiftName}`,
                detail: result.rows[0]?.reason ?? result.errors[0] ?? "The shift could not be given to them.",
              },
        );
      } catch (e) {
        steps.push({ key: "shift", ok: false, title: `Not put on ${shiftName}`, detail: errorText(e) });
      }
    }
    setBusy(false);
    if (allStepsOk(steps)) {
      toast({
        title: `${row.name} added to Factory Employees`,
        description:
          steps
            .slice(1)
            .map((s) => s.title)
            .join(" · ") || "Paid in Staff Payroll (Monthly).",
      });
      p.onClose();
      return;
    }
    toast({
      title: `${row.name} was created, with a problem`,
      description: steps.find((s) => !s.ok)?.detail ?? undefined,
      variant: "destructive",
    });
    setDone({ row, steps });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && p.onClose()}>
      <DialogContent
        className="flex max-h-[94vh] w-[calc(100%-1rem)] max-w-3xl flex-col gap-0 overflow-hidden p-0"
        data-testid="fe-create-dialog"
      >
        <DialogHeader className="border-b bg-gradient-to-br from-teal-50 via-white to-sky-50/60 px-5 py-4 pr-14">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-teal-600 text-white shadow-sm">
              <UserPlus size={19} />
            </span>
            <div className="min-w-0">
              <DialogTitle className="text-lg font-black">New factory employee</DialogTitle>
              <DialogDescription className="text-xs">
                An ordinary employee in every way (attendance, payroll, All Employees), listed here with their label.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {done ? (
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-5" data-testid="fe-create-result">
            <ul className="space-y-2">
              {done.steps.map((s) => (
                <li
                  key={s.key}
                  className={cn(
                    "flex items-start gap-2 rounded-xl border px-3 py-2.5 text-sm",
                    s.ok
                      ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                      : "border-red-200 bg-red-50 text-red-900",
                  )}
                  data-testid={`fe-create-step-${s.key}`}
                  data-ok={s.ok ? "true" : "false"}
                >
                  {s.ok ? (
                    <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
                  ) : (
                    <XCircle size={16} className="mt-0.5 shrink-0" />
                  )}
                  <span>
                    <b>{s.title}</b>
                    {s.detail && <span className="block text-xs opacity-80">{s.detail}</span>}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-sm text-muted-foreground">
              The employee is saved. Fix what failed from the list: the row&apos;s menu has Set payroll and Assign
              shift.
            </p>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="outline" onClick={() => p.onOpenProfile(done.row)}>
                Open their profile
              </Button>
              <Button onClick={p.onClose} data-testid="fe-create-done">
                Done
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto bg-gray-50/60 px-4 py-4 sm:px-5" ref={topRef}>
              {serverError && (
                <p
                  className="rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-800"
                  role="alert"
                  data-testid="fe-create-error"
                >
                  <b>Not created:</b> {serverError}
                </p>
              )}

              <FormSection title="Personal details" testId="fe-create-personal">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field
                    label="Employee code"
                    htmlFor="fe-c-code"
                    required
                    error={shown("employeeCode")}
                    className="sm:col-span-2"
                  >
                    <Input
                      id="fe-c-code"
                      value={form.employeeCode}
                      onChange={(e) => set("employeeCode", e.target.value)}
                      placeholder="e.g. F001"
                      data-testid="fe-c-code"
                    />
                  </Field>
                  <Field label="First name" htmlFor="fe-c-first" required error={shown("firstName")}>
                    <Input
                      id="fe-c-first"
                      value={form.firstName}
                      onChange={(e) => set("firstName", e.target.value)}
                      data-testid="fe-c-first"
                    />
                  </Field>
                  <Field label="Last name" htmlFor="fe-c-last" required error={shown("lastName")}>
                    <Input
                      id="fe-c-last"
                      value={form.lastName}
                      onChange={(e) => set("lastName", e.target.value)}
                      data-testid="fe-c-last"
                    />
                  </Field>
                  <Field label="Phone" htmlFor="fe-c-phone" required error={shown("phone")}>
                    <Input
                      id="fe-c-phone"
                      inputMode="tel"
                      value={form.phone}
                      onChange={(e) => set("phone", e.target.value)}
                      data-testid="fe-c-phone"
                    />
                  </Field>
                  <Field label="Gender" htmlFor="fe-c-gender">
                    <select
                      id="fe-c-gender"
                      className={SELECT_CLASS}
                      value={form.gender}
                      onChange={(e) => set("gender", e.target.value)}
                      data-testid="fe-c-gender"
                    >
                      <option value="">Not given</option>
                      <option value="male">Male</option>
                      <option value="female">Female</option>
                      <option value="other">Other</option>
                    </select>
                  </Field>
                  <Field label="Date of birth" htmlFor="fe-c-dob">
                    <Input
                      id="fe-c-dob"
                      type="date"
                      value={form.dateOfBirth}
                      onChange={(e) => set("dateOfBirth", e.target.value)}
                    />
                  </Field>
                </div>
              </FormSection>

              <FormSection title="Job" testId="fe-create-job">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field
                    label="Label"
                    htmlFor="fe-c-label"
                    className="sm:col-span-2"
                    hint={`What they do: Driver, Housekeeping, Chef, Security... ${LABEL_IS_DEPARTMENT}`}
                  >
                    <select
                      id="fe-c-label"
                      className={SELECT_CLASS}
                      value={form.labelId}
                      onChange={(e) => set("labelId", e.target.value)}
                      data-testid="fe-c-label"
                    >
                      <option value="">No label</option>
                      {sortLabels(p.labels).map((l) => (
                        <option key={l.id} value={String(l.id)}>
                          {l.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {p.needsBranch && (
                    <Field label="Branch" htmlFor="fe-c-branch" required error={shown("branchId")}>
                      <select
                        id="fe-c-branch"
                        className={SELECT_CLASS}
                        value={form.branchId}
                        onChange={(e) => set("branchId", e.target.value)}
                        data-testid="fe-c-branch"
                      >
                        <option value="">Select a branch</option>
                        {p.branches.map((b) => (
                          <option key={b.id} value={String(b.id)}>
                            {b.name}
                            {b.isHeadOffice ? " (Head Office)" : ""}
                          </option>
                        ))}
                      </select>
                    </Field>
                  )}
                  <Field label="Join date" htmlFor="fe-c-join" error={shown("joinDate")}>
                    <Input
                      id="fe-c-join"
                      type="date"
                      value={form.joinDate}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, joinDate: e.target.value, shiftFrom: e.target.value || f.shiftFrom }))
                      }
                      data-testid="fe-c-join"
                    />
                  </Field>
                </div>
              </FormSection>

              <FormSection title="Payroll" testId="fe-create-pay">
                <PayrollFields
                  form={form}
                  onChange={setPayrollPart}
                  problems={
                    submitted
                      ? {
                          payCycle: problems.payCycle,
                          salaryAmount: problems.salaryAmount,
                          salaryPerShift: problems.salaryPerShift,
                          split: problems.split,
                        }
                      : {}
                  }
                  testId="fe-c-pay"
                />
              </FormSection>

              <FormSection
                title="Shift"
                hint={
                  production
                    ? "Production employees get the production shift from Settings automatically; choose one to use another."
                    : "Optional: the working hours attendance judges them by."
                }
                testId="fe-create-shift"
              >
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Shift" htmlFor="fe-c-shift">
                    <select
                      id="fe-c-shift"
                      className={SELECT_CLASS}
                      value={form.shiftId}
                      onChange={(e) => set("shiftId", e.target.value)}
                      data-testid="fe-c-shift"
                    >
                      <option value="">{production ? "The default production shift" : "None for now"}</option>
                      {offeredShifts.map((s) => (
                        <option key={s.id} value={String(s.id)}>
                          {s.name} ({s.startTime}-{s.endTime})
                        </option>
                      ))}
                    </select>
                  </Field>
                  {form.shiftId && (
                    <Field label="On the shift from" htmlFor="fe-c-shift-from" error={shown("shiftFrom")}>
                      <Input
                        id="fe-c-shift-from"
                        type="date"
                        value={form.shiftFrom}
                        onChange={(e) => set("shiftFrom", e.target.value)}
                        data-testid="fe-c-shift-from"
                      />
                    </Field>
                  )}
                  {form.shiftId && !production && (
                    <label className="flex cursor-pointer items-center justify-between gap-3 rounded-xl border px-3 py-2.5 sm:col-span-2">
                      <span>
                        <span className="block text-sm font-semibold text-gray-900">Saturday off</span>
                        <span className="block text-xs text-muted-foreground">Monday to Friday only</span>
                      </span>
                      <Switch
                        checked={form.saturdayOff}
                        onCheckedChange={(v) => set("saturdayOff", v)}
                        aria-label="Saturday off"
                      />
                    </label>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Shifts are created and changed on{" "}
                  <Link href="/hr/shifts" className="font-semibold text-sky-700 hover:underline">
                    Manage Shifts
                  </Link>
                  .
                </p>
              </FormSection>

              <FormSection title="Bank" hint="Optional: can be added later." testId="fe-create-bank">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <Field label="Bank name" htmlFor="fe-c-bank">
                    <Input id="fe-c-bank" value={form.bankName} onChange={(e) => set("bankName", e.target.value)} />
                  </Field>
                  <Field label="Account number" htmlFor="fe-c-account">
                    <Input
                      id="fe-c-account"
                      inputMode="numeric"
                      value={form.bankAccount}
                      onChange={(e) => set("bankAccount", e.target.value)}
                    />
                  </Field>
                  <Field label="IFSC" htmlFor="fe-c-ifsc">
                    <Input
                      id="fe-c-ifsc"
                      value={form.bankIfsc}
                      onChange={(e) => set("bankIfsc", e.target.value.toUpperCase())}
                    />
                  </Field>
                </div>
              </FormSection>

              <p className="px-1 text-xs text-muted-foreground">
                Photo, family and statutory details are on the{" "}
                <Link href="/hr/employees/new" className="font-semibold text-sky-700 hover:underline">
                  full Add Employee form
                </Link>{" "}
                or the employee&apos;s profile afterwards.
              </p>
            </div>

            <div className="flex flex-col-reverse gap-2 border-t bg-white px-5 py-3 sm:flex-row sm:items-center sm:justify-end">
              <Button variant="ghost" onClick={p.onClose} disabled={busy}>
                Cancel
              </Button>
              <Button onClick={() => void submit()} disabled={busy} data-testid="fe-create-save">
                {busy ? "Saving…" : "Create employee"}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
