import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { VisitorVisit } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { fmtDate, fmtTime } from "@/pages/hr/outpass-visitors/kit/fmt";
import { ID_PROOF_TYPES } from "@/pages/hr/outpass-visitors/visitors/logic";
import {
  DeskError,
  deskHostLookup,
  sessionEnded,
  useDeskRegister,
  useDeskVisitorLookup,
  type DeskRegisterInput,
  type DeskReturningVisitor,
} from "./desk-api";
import { MeetingEmployeeField } from "./MeetingEmployeeField";

const FIELD =
  "h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none sm:h-10 " +
  "focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring/50";

type Form = {
  phone: string;
  name: string;
  company: string;
  peopleCount: string;
  vehicleNumber: string;
  idProofType: string;
  aadhaarNumber: string;
  badgeNumber: string;
  whomToMeet: string;
  meetingEmployeeId: number | undefined;
  purpose: string;
  notes: string;
};

const BLANK: Form = {
  phone: "",
  name: "",
  company: "",
  peopleCount: "1",
  vehicleNumber: "",
  idProofType: "",
  aadhaarNumber: "",
  badgeNumber: "",
  whomToMeet: "",
  meetingEmployeeId: undefined,
  purpose: "",
  notes: "",
};

/**
 * The reception desk checks a walk-in visitor in (POST /api/reception-devices/visits with the desk's token): the same
 * form and checks as HR's Register visitor, without a branch (a desk always registers at its own). The phone first (a
 * returning visitor of this branch is recognised and their name filled in), then who they are, whom they are meeting
 * (looked up by the employee's phone, which also tells that person they arrived) and why. Saving checks the visitor in
 * now.
 */
export function DeskRegisterDialog({
  open,
  onClose,
  onRegistered,
}: {
  open: boolean;
  onClose: () => void;
  onRegistered: (visit: VisitorVisit) => void;
}) {
  const ids = useId();
  const [form, setForm] = useState<Form>(BLANK);
  const [error, setError] = useState<string | null>(null);
  const [phoneToCheck, setPhoneToCheck] = useState("");
  // a fresh look-up field each time the dialog opens
  const [round, setRound] = useState(0);
  const register = useDeskRegister();
  const returning = useDeskVisitorLookup(open ? phoneToCheck : "");
  const known = returning.data ?? null;

  useEffect(() => {
    if (open) {
      setForm(BLANK);
      setError(null);
      setPhoneToCheck("");
      setRound((r) => r + 1);
    }
  }, [open]);

  // a returning visitor's name is filled in (and stays editable)
  useEffect(() => {
    if (known && !form.name) setForm((f) => ({ ...f, name: known.name }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [known?.id]);

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (form.phone.replace(/\D/g, "").length < 6)
      return setError("Enter the visitor's phone number (at least 6 digits).");
    if (!form.name.trim() && !known) return setError("Enter the visitor's name.");
    if (!form.whomToMeet.trim()) return setError("Enter whom the visitor is meeting.");
    if (!form.purpose.trim()) return setError("Enter the purpose of the visit.");
    const people = Number(form.peopleCount);
    if (!Number.isInteger(people) || people < 1 || people > 50)
      return setError("Number of people must be between 1 and 50.");
    const aadhaar = form.aadhaarNumber.replace(/\s/g, "");
    if (aadhaar && !/^\d{12}$/.test(aadhaar)) return setError("An Aadhaar number has 12 digits.");

    const body: DeskRegisterInput = {
      name: form.name.trim(),
      phone: form.phone.trim(),
      whomToMeet: form.whomToMeet.trim(),
      purpose: form.purpose.trim(),
      peopleCount: people,
    };
    if (form.meetingEmployeeId) body.meetingEmployeeId = form.meetingEmployeeId;
    if (form.company.trim()) body.company = form.company.trim();
    if (form.vehicleNumber.trim()) body.vehicleNumber = form.vehicleNumber.trim();
    if (form.idProofType) body.idProofType = form.idProofType;
    if (aadhaar) body.aadhaarNumber = aadhaar;
    if (form.badgeNumber.trim()) body.badgeNumber = form.badgeNumber.trim();
    if (form.notes.trim()) body.notes = form.notes.trim();

    try {
      const visit = await register.mutateAsync(body);
      onRegistered(visit);
    } catch (err) {
      if (sessionEnded(err)) return; // on its way to the sign-in page
      setError(err instanceof DeskError ? err.message : "Could not check the visitor in. Please try again.");
    }
  };

  const id = (name: string) => `${ids}-${name}`;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !register.isPending && onClose()}>
      <DialogContent
        className="max-h-[92vh] w-[calc(100%-2rem)] max-w-2xl overflow-y-auto"
        data-testid="desk-register-dialog"
      >
        <DialogHeader>
          <DialogTitle>Register a visitor</DialogTitle>
          <DialogDescription>The visitor is checked in now at this desk. Fields marked * are needed.</DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4" noValidate data-testid="desk-register-form">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Phone number *" htmlFor={id("phone")}>
              <input
                id={id("phone")}
                value={form.phone}
                inputMode="tel"
                autoComplete="off"
                maxLength={20}
                onChange={(e) => {
                  set("phone", e.target.value);
                  setPhoneToCheck(""); // checked again when the field is left
                }}
                onBlur={() => setPhoneToCheck(form.phone.trim())}
                className={FIELD}
                data-testid="register-phone"
              />
              <ReturningNote
                checking={returning.isFetching && !!phoneToCheck}
                checked={returning.isSuccess && !!phoneToCheck}
                known={known}
              />
            </Field>
            <Field label={known ? "Name" : "Name *"} htmlFor={id("name")}>
              <input
                id={id("name")}
                value={form.name}
                maxLength={120}
                autoComplete="off"
                onChange={(e) => set("name", e.target.value)}
                className={FIELD}
                data-testid="register-name"
              />
            </Field>
            <Field label="Company" htmlFor={id("company")}>
              <input
                id={id("company")}
                value={form.company}
                maxLength={120}
                onChange={(e) => set("company", e.target.value)}
                className={FIELD}
                data-testid="register-company"
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="People" htmlFor={id("people")}>
                <input
                  id={id("people")}
                  type="number"
                  min={1}
                  max={50}
                  value={form.peopleCount}
                  onChange={(e) => set("peopleCount", e.target.value)}
                  className={FIELD}
                  data-testid="register-people"
                />
              </Field>
              <Field label="Vehicle number" htmlFor={id("vehicle")}>
                <input
                  id={id("vehicle")}
                  value={form.vehicleNumber}
                  maxLength={20}
                  onChange={(e) => set("vehicleNumber", e.target.value)}
                  className={cn(FIELD, "uppercase")}
                  data-testid="register-vehicle"
                />
              </Field>
            </div>
            <Field label="ID proof" htmlFor={id("idproof")}>
              <select
                id={id("idproof")}
                value={form.idProofType}
                onChange={(e) => set("idProofType", e.target.value)}
                className={FIELD}
                data-testid="register-id-proof"
              >
                <option value="">None seen</option>
                {ID_PROOF_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Badge number" htmlFor={id("badge")}>
              <input
                id={id("badge")}
                value={form.badgeNumber}
                maxLength={30}
                onChange={(e) => set("badgeNumber", e.target.value)}
                className={FIELD}
                data-testid="register-badge"
              />
            </Field>
            {form.idProofType === "Aadhaar" && (
              <Field label="Aadhaar number" htmlFor={id("aadhaar")}>
                <input
                  id={id("aadhaar")}
                  value={form.aadhaarNumber}
                  inputMode="numeric"
                  maxLength={14}
                  autoComplete="off"
                  onChange={(e) => set("aadhaarNumber", e.target.value)}
                  className={FIELD}
                  data-testid="register-aadhaar"
                />
              </Field>
            )}
          </div>

          <MeetingEmployeeField
            key={round}
            token=""
            lookup={deskHostLookup}
            whomToMeet={form.whomToMeet}
            onWhomToMeetChange={(v) => set("whomToMeet", v)}
            onMeetingEmployeeIdChange={(v) => set("meetingEmployeeId", v)}
            question="Is the visitor meeting a specific employee? *"
            whomLabel="Whom is the visitor meeting? *"
          />

          <Field label="Purpose of the visit *" htmlFor={id("purpose")}>
            <input
              id={id("purpose")}
              value={form.purpose}
              maxLength={300}
              onChange={(e) => set("purpose", e.target.value)}
              className={FIELD}
              data-testid="register-purpose"
            />
          </Field>
          <Field label="Notes" htmlFor={id("notes")}>
            <textarea
              id={id("notes")}
              value={form.notes}
              maxLength={1000}
              rows={2}
              onChange={(e) => set("notes", e.target.value)}
              className={cn(FIELD, "h-auto py-2 sm:h-auto")}
              data-testid="register-notes"
            />
          </Field>

          {error && (
            <p
              role="alert"
              className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700"
              data-testid="register-error"
            >
              {error}
            </p>
          )}

          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-11 sm:h-9"
              onClick={onClose}
              disabled={register.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              className="h-11 gap-1.5 sm:h-9"
              disabled={register.isPending}
              data-testid="register-submit"
            >
              <UserPlus size={15} aria-hidden="true" />
              {register.isPending ? "Checking in…" : "Check in visitor"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium text-slate-700">
        {label}
      </label>
      {children}
    </div>
  );
}

function ReturningNote({
  checking,
  checked,
  known,
}: {
  checking: boolean;
  checked: boolean;
  known: DeskReturningVisitor | null;
}) {
  if (checking) return <p className="text-xs text-slate-500">Checking the number…</p>;
  if (!checked) return null;
  if (!known)
    return (
      <p className="text-xs text-slate-500" data-testid="register-new-visitor">
        New visitor.
      </p>
    );
  return (
    <p className="text-xs text-slate-700" data-testid="register-returning">
      Returning visitor: {known.name}, {known.visitCount} {known.visitCount === 1 ? "visit" : "visits"}
      {known.lastVisitAt ? `, last on ${fmtDate(known.lastVisitAt)} at ${fmtTime(known.lastVisitAt)}` : ""}.
      {known.insideNow && <span className="font-medium text-amber-700"> Still inside: check them out first.</span>}
    </p>
  );
}
