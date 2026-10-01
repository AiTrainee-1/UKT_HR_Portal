import { useMemo, useState, type ReactNode } from "react";
import { AlertCircle, Factory, Info, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { ApiError } from "@/lib/api-client/custom-fetch";
import {
  useSaveShiftTemplate,
  type GenderRule,
  type ShiftFieldErrors,
  type ShiftItem,
  type ShiftType,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import {
  durationLabel,
  emptyShiftForm,
  formFromShift,
  formPayload,
  isValid,
  validateShiftForm,
  type ShiftForm,
} from "./shift-logic";

function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: string;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="text-sm font-semibold text-gray-800">
        {label}
      </label>
      {children}
      {error ? (
        <p className="flex items-start gap-1 text-xs font-medium text-red-600" role="alert">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          {error}
        </p>
      ) : (
        hint && <p className="text-xs text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

function Choice<T extends string>({
  value,
  options,
  onChange,
  disabled,
  testId,
}: {
  value: T;
  options: { value: T; label: string; sub?: string; icon?: ReactNode }[];
  onChange: (v: T) => void;
  disabled?: boolean;
  testId: string;
}) {
  return (
    <div
      className="grid gap-2"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
      role="radiogroup"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={disabled}
          onClick={() => onChange(o.value)}
          data-testid={`${testId}-${o.value}`}
          className={cn(
            "rounded-xl border p-2.5 text-left transition-all disabled:cursor-not-allowed",
            value === o.value
              ? "border-primary bg-primary/5 ring-1 ring-primary/30"
              : "border-gray-200 bg-white hover:border-gray-300",
            disabled && value !== o.value && "opacity-50",
          )}
        >
          <span className="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
            {o.icon}
            {o.label}
          </span>
          {o.sub && <span className="mt-0.5 block text-xs text-muted-foreground">{o.sub}</span>}
        </button>
      ))}
    </div>
  );
}

/**
 * Create or edit a shift template. The rules are checked while typing (the same ones the server enforces: a unique name,
 * no overnight shift, a lunch break inside the shift...), and whatever the server still refuses is shown against its
 * field. A shift with people on it cannot change type, and the dialog says what editing it will affect.
 */
export default function ShiftFormDialog({
  open,
  onClose,
  editing,
  defaultType,
  shifts,
}: {
  open: boolean;
  onClose: () => void;
  editing: ShiftItem | null;
  defaultType: ShiftType;
  shifts: ShiftItem[];
}) {
  const { toast } = useToast();
  const save = useSaveShiftTemplate();
  // The parent mounts this per open, so the form always starts from the shift being edited (or a blank one).
  const [form, setForm] = useState<ShiftForm>(() => (editing ? formFromShift(editing) : emptyShiftForm(defaultType)));
  const [touched, setTouched] = useState<Partial<Record<keyof ShiftForm, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [serverErrors, setServerErrors] = useState<ShiftFieldErrors>({});

  const errors = useMemo(() => validateShiftForm(form, shifts, editing?.id ?? null), [form, shifts, editing]);
  const shown = (k: keyof ShiftForm) => (touched[k] || submitted ? (errors[k] ?? serverErrors[k]) : serverErrors[k]);
  const used = editing?.assignedCount ?? 0;
  const length = durationLabel(form.startTime, form.endTime);

  const set = <K extends keyof ShiftForm>(k: K, v: ShiftForm[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setServerErrors((e) => ({ ...e, [k]: undefined }));
  };
  const blur = (k: keyof ShiftForm) => setTouched((t) => ({ ...t, [k]: true }));

  const submit = async () => {
    setSubmitted(true);
    if (!isValid(errors)) return;
    try {
      await save.mutateAsync({ id: editing?.id, data: formPayload(form) });
    } catch (e) {
      const fields =
        e instanceof ApiError ? ((e.data as { fieldErrors?: ShiftFieldErrors } | null)?.fieldErrors ?? null) : null;
      if (fields) setServerErrors(fields);
      toast({
        title: editing ? "Could not update the shift" : "Could not create the shift",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
      return;
    }
    toast({ title: editing ? `${form.name.trim()} updated` : `${form.name.trim()} created` });
    onClose();
  };

  const staff = form.shiftType === "staff";

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="flex max-h-[92vh] w-[calc(100%-1.5rem)] max-w-xl flex-col gap-0 overflow-hidden p-0"
        data-testid="shift-form-dialog"
      >
        <DialogHeader className="border-b bg-gradient-to-br from-emerald-50 via-white to-sky-50/60 px-5 py-4 pr-14 sm:px-6">
          <DialogTitle className="text-lg font-black">{editing ? "Edit shift" : "Create a shift"}</DialogTitle>
          <DialogDescription className="text-xs">
            {editing
              ? "Change the hours and rules of this shift."
              : "A shift is a set of working hours. Create it here, then assign people to it."}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5 sm:px-6">
          {editing && used > 0 && (
            <p
              className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2.5 text-xs text-amber-900"
              data-testid="shift-in-use-note"
            >
              <Info size={14} className="mt-0.5 shrink-0 text-amber-600" />
              <span>
                <b>
                  {used} employee{used === 1 ? "" : "s"}
                </b>{" "}
                {used === 1 ? "is" : "are"} on this shift. New hours and grace apply to them from the next attendance
                calculation. The type cannot be changed while anyone is on it.
              </span>
            </p>
          )}

          <Field label="Shift name" error={shown("name")} htmlFor="shift-name">
            <Input
              id="shift-name"
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              onBlur={() => blur("name")}
              placeholder="e.g. General shift"
              autoFocus
              maxLength={80}
              aria-invalid={!!shown("name")}
              data-testid="shift-name"
            />
          </Field>

          <Field label="Who is it for?">
            <Choice<ShiftType>
              testId="shift-type"
              value={form.shiftType}
              disabled={!!editing && used > 0}
              onChange={(v) => {
                setForm((f) => ({
                  ...f,
                  shiftType: v,
                  genderRule: v === "production" ? "all" : f.genderRule,
                  endTime:
                    !editing && f.endTime === (f.shiftType === "staff" ? "19:00" : "20:00")
                      ? v === "staff"
                        ? "19:00"
                        : "20:00"
                      : f.endTime,
                }));
              }}
              options={[
                { value: "staff", label: "Staff", sub: "Paid monthly, lunch break", icon: <Users size={14} /> },
                { value: "production", label: "Production", sub: "Paid per shift", icon: <Factory size={14} /> },
              ]}
            />
          </Field>

          {staff ? (
            <Field
              label="Gender"
              hint="A Male or Female only shift can only be given to that gender."
              error={shown("genderRule")}
            >
              <Choice<GenderRule>
                testId="shift-gender"
                value={form.genderRule}
                onChange={(v) => set("genderRule", v)}
                options={[
                  { value: "all", label: "Everyone" },
                  { value: "male", label: "Male only" },
                  { value: "female", label: "Female only" },
                ]}
              />
            </Field>
          ) : (
            <p className="rounded-xl bg-gray-50 px-3 py-2 text-xs text-muted-foreground">
              Production shifts apply to every production employee, whatever their gender.
            </p>
          )}

          <div className="space-y-3 rounded-2xl border bg-gray-50/50 p-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-bold text-gray-900">Working hours</p>
              {length && (
                <span
                  className="rounded-full bg-white px-2.5 py-0.5 text-xs font-semibold text-gray-600 shadow-sm"
                  data-testid="shift-length"
                >
                  {length}
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Starts" error={shown("startTime")} htmlFor="shift-start">
                <Input
                  id="shift-start"
                  type="time"
                  value={form.startTime}
                  onChange={(e) => set("startTime", e.target.value)}
                  onBlur={() => blur("startTime")}
                  aria-invalid={!!shown("startTime")}
                  data-testid="shift-start"
                />
              </Field>
              <Field label="Ends" error={shown("endTime")} htmlFor="shift-end">
                <Input
                  id="shift-end"
                  type="time"
                  value={form.endTime}
                  onChange={(e) => set("endTime", e.target.value)}
                  onBlur={() => blur("endTime")}
                  aria-invalid={!!shown("endTime")}
                  data-testid="shift-end"
                />
              </Field>
            </div>
            <Field
              label="Grace period (minutes)"
              error={shown("gracePeriodMinutes")}
              hint={
                staff
                  ? "Late-In is flagged after the start plus grace, and Early-Out (when switched on in Settings) before the end minus grace."
                  : "Arrivals within this many minutes of the start are on time."
              }
              htmlFor="shift-grace"
            >
              <Input
                id="shift-grace"
                type="number"
                inputMode="numeric"
                min={0}
                max={60}
                value={form.gracePeriodMinutes}
                onChange={(e) => set("gracePeriodMinutes", e.target.value)}
                onBlur={() => blur("gracePeriodMinutes")}
                className="max-w-[9rem]"
                aria-invalid={!!shown("gracePeriodMinutes")}
                data-testid="shift-grace"
              />
            </Field>
          </div>

          {staff && (
            <div className="space-y-3 rounded-2xl border border-dashed border-emerald-200 bg-emerald-50/40 p-4">
              <p className="text-sm font-bold text-emerald-900">
                Lunch break <span className="text-xs font-normal text-emerald-700">defines the 4-punch day</span>
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Field label="First half ends" error={shown("firstHalfEnd")} htmlFor="shift-half">
                  <Input
                    id="shift-half"
                    type="time"
                    value={form.firstHalfEnd}
                    onChange={(e) => set("firstHalfEnd", e.target.value)}
                    onBlur={() => blur("firstHalfEnd")}
                    aria-invalid={!!shown("firstHalfEnd")}
                    data-testid="shift-half"
                  />
                </Field>
                <Field label="Lunch (min)" error={shown("lunchDurationMinutes")} htmlFor="shift-lunch">
                  <Input
                    id="shift-lunch"
                    type="number"
                    inputMode="numeric"
                    min={15}
                    max={120}
                    value={form.lunchDurationMinutes}
                    onChange={(e) => set("lunchDurationMinutes", e.target.value)}
                    onBlur={() => blur("lunchDurationMinutes")}
                    aria-invalid={!!shown("lunchDurationMinutes")}
                  />
                </Field>
                <Field label="Lunch grace (min)" error={shown("lunchGraceMinutes")} htmlFor="shift-lunch-grace">
                  <Input
                    id="shift-lunch-grace"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={30}
                    value={form.lunchGraceMinutes}
                    onChange={(e) => set("lunchGraceMinutes", e.target.value)}
                    onBlur={() => blur("lunchGraceMinutes")}
                    aria-invalid={!!shown("lunchGraceMinutes")}
                  />
                </Field>
              </div>
              <p className="text-xs leading-relaxed text-emerald-800">
                Example: first half ends {form.firstHalfEnd || "13:30"} with {form.lunchGraceMinutes || "10"} min grace,
                so employees can go for lunch until then. A late return from lunch is recorded in Strict mode for
                information only: it never changes Full or Half Day.
              </p>
            </div>
          )}
        </div>

        <div className="flex flex-col-reverse gap-2 border-t bg-gray-50/80 px-5 py-3 sm:flex-row sm:items-center sm:justify-end sm:px-6">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={save.isPending} data-testid="shift-save">
            {save.isPending ? "Saving…" : editing ? "Save changes" : "Create shift"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
