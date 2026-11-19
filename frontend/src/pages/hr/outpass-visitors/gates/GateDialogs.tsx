import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { Eye, EyeOff, KeyRound, Shuffle } from "lucide-react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import {
  useCreateManagedGate,
  useUpdateManagedGate,
  type GateUpdateInput,
  type ManagedGate,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { CopyButton, FIELD, FLAT_SWITCH, GateButton } from "./parts";
import { errorText, generatePassword, passwordProblem, usernameProblem } from "./logic";

/** The flat white look of the page's dialogs (the app's default dialog is frosted glass). */
const DIALOG =
  "w-[calc(100%-2rem)] max-w-md max-h-[90vh] overflow-y-auto border-slate-200 bg-white shadow-sm backdrop-blur-none";

type Branch = { id: number; name: string };

function Field({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  htmlFor: string;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block text-xs font-semibold text-slate-700">
        {label}
      </label>
      {children}
      {hint && <p className="text-[11px] text-slate-500">{hint}</p>}
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
  testId,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  testId?: string;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2.5">
      <div className="min-w-0">
        <label htmlFor={id} className="block text-sm font-medium text-slate-800">
          {label}
        </label>
        <p className="text-[11px] text-slate-500">{hint}</p>
      </div>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        data-testid={testId}
        className={cn("mt-0.5", FLAT_SWITCH)}
      />
    </div>
  );
}

/** A password box with Show / Hide and "Suggest one" (a random, easy-to-read password). */
function PasswordInput({
  id,
  value,
  onChange,
  testId,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  testId?: string;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div className="flex gap-2">
      <div className="relative min-w-0 flex-1">
        <input
          id={id}
          type={shown ? "text" : "password"}
          value={value}
          autoComplete="new-password"
          onChange={(e) => onChange(e.target.value)}
          className={cn(FIELD, "pr-11 font-mono")}
          data-testid={testId}
        />
        <button
          type="button"
          onClick={() => setShown((s) => !s)}
          aria-label={shown ? "Hide the password" : "Show the password"}
          className="absolute right-0 top-0 flex h-11 w-11 items-center justify-center text-slate-500 hover:text-slate-800 sm:h-10"
        >
          {shown ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
      </div>
      <GateButton
        icon={Shuffle}
        onClick={() => {
          onChange(generatePassword());
          setShown(true);
        }}
        data-testid={testId ? `${testId}-suggest` : undefined}
      >
        Suggest
      </GateButton>
    </div>
  );
}

function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
      {message}
    </p>
  );
}

// ── Add gate ──────────────────────────────────────────────────────────────────

const EMPTY_FORM = {
  name: "",
  branchId: "",
  location: "",
  username: "",
  password: "",
  notes: "",
  allowOutpass: true,
  allowTeaBreak: true,
};

export function AddGateDialog({
  open,
  onOpenChange,
  isBranchScoped,
  branches,
  defaultBranchId,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isBranchScoped: boolean;
  branches: readonly Branch[] | undefined;
  defaultBranchId?: string;
  onAdded: (gate: ManagedGate) => void;
}) {
  const id = useId();
  const { toast } = useToast();
  const create = useCreateManagedGate();
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);

  // a fresh form each time it opens (not when the branch list refreshes while someone types)
  useEffect(() => {
    if (open) {
      setForm({ ...EMPTY_FORM, branchId: defaultBranchId ?? (branches?.length === 1 ? String(branches[0].id) : "") });
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const patch = (p: Partial<typeof EMPTY_FORM>) => setForm((f) => ({ ...f, ...p }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const problem =
      (!form.name.trim() && "Give the gate a name.") ||
      (!isBranchScoped && !form.branchId && "Choose the branch of this gate.") ||
      usernameProblem(form.username) ||
      passwordProblem(form.password);
    if (problem) return setError(problem);
    try {
      const gate = await create.mutateAsync({
        name: form.name.trim(),
        branchId: !isBranchScoped && form.branchId ? Number(form.branchId) : undefined,
        username: form.username.trim(),
        password: form.password,
        location: form.location.trim() || null,
        notes: form.notes.trim() || null,
        allowOutpass: form.allowOutpass,
        allowTeaBreak: form.allowTeaBreak,
      });
      toast({ title: "Gate added", description: `${gate.name} can now sign in at the gate monitor address.` });
      onOpenChange(false);
      onAdded(gate);
    } catch (err) {
      setError(errorText(err, "The gate could not be added. Try again."));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={DIALOG} data-testid="gate-add-dialog">
        <DialogHeader>
          <DialogTitle>Add a gate</DialogTitle>
          <DialogDescription>
            The gate signs in at the gate monitor address with this username and password.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3" noValidate>
          <Field label="Gate name" htmlFor={`${id}-name`}>
            <input
              id={`${id}-name`}
              value={form.name}
              onChange={(e) => patch({ name: e.target.value })}
              className={FIELD}
              placeholder="Main Gate"
              data-testid="gate-form-name"
            />
          </Field>
          {!isBranchScoped && (
            <Field label="Branch" htmlFor={`${id}-branch`}>
              <select
                id={`${id}-branch`}
                value={form.branchId}
                onChange={(e) => patch({ branchId: e.target.value })}
                className={FIELD}
                data-testid="gate-form-branch"
              >
                <option value="">Choose a branch</option>
                {branches?.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Location (optional)" htmlFor={`${id}-location`}>
            <input
              id={`${id}-location`}
              value={form.location}
              onChange={(e) => patch({ location: e.target.value })}
              className={FIELD}
              placeholder="Spinning side, near the canteen"
              data-testid="gate-form-location"
            />
          </Field>
          <Field label="Username" hint="At least 3 characters, no spaces." htmlFor={`${id}-username`}>
            <input
              id={`${id}-username`}
              value={form.username}
              autoComplete="off"
              onChange={(e) => patch({ username: e.target.value })}
              className={cn(FIELD, "font-mono")}
              placeholder="main.gate"
              data-testid="gate-form-username"
            />
          </Field>
          <Field label="Password" hint="At least 6 characters." htmlFor={`${id}-password`}>
            <PasswordInput
              id={`${id}-password`}
              value={form.password}
              onChange={(password) => patch({ password })}
              testId="gate-form-password"
            />
          </Field>
          <Toggle
            label="Takes gate passes"
            hint="Scans passes going out and coming back."
            checked={form.allowOutpass}
            onChange={(allowOutpass) => patch({ allowOutpass })}
            testId="gate-form-allow-outpass"
          />
          <Toggle
            label="Takes tea breaks"
            hint="Scans tea-break codes."
            checked={form.allowTeaBreak}
            onChange={(allowTeaBreak) => patch({ allowTeaBreak })}
            testId="gate-form-allow-tea"
          />
          <FormError message={error} />
          <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
            <GateButton onClick={() => onOpenChange(false)}>Cancel</GateButton>
            <GateButton tone="primary" type="submit" disabled={create.isPending} data-testid="gate-add-submit">
              {create.isPending ? "Adding…" : "Add gate"}
            </GateButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Edit gate ─────────────────────────────────────────────────────────────────

export function EditGateDialog({
  gate,
  open,
  onOpenChange,
  isBranchScoped,
  branches,
}: {
  gate: ManagedGate;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isBranchScoped: boolean;
  branches: readonly Branch[] | undefined;
}) {
  const id = useId();
  const { toast } = useToast();
  const update = useUpdateManagedGate();
  const start = () => ({
    name: gate.name,
    branchId: gate.branchId ? String(gate.branchId) : "",
    location: gate.location ?? "",
    username: gate.username,
    notes: gate.notes ?? "",
    allowOutpass: gate.allowOutpass,
    allowTeaBreak: gate.allowTeaBreak,
  });
  const [form, setForm] = useState(start);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setForm(start());
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, gate.id]);

  const patch = (p: Partial<ReturnType<typeof start>>) => setForm((f) => ({ ...f, ...p }));
  const usernameChanged = form.username.trim().toLowerCase() !== gate.username.toLowerCase();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const problem = (!form.name.trim() && "The gate needs a name.") || usernameProblem(form.username);
    if (problem) return setError(problem);
    const data: GateUpdateInput = {};
    if (form.name.trim() !== gate.name) data.name = form.name.trim();
    if (!isBranchScoped && form.branchId && Number(form.branchId) !== gate.branchId)
      data.branchId = Number(form.branchId);
    if (form.username.trim() !== gate.username) data.username = form.username.trim();
    if ((form.location.trim() || null) !== gate.location) data.location = form.location.trim() || null;
    if ((form.notes.trim() || null) !== gate.notes) data.notes = form.notes.trim() || null;
    if (form.allowOutpass !== gate.allowOutpass) data.allowOutpass = form.allowOutpass;
    if (form.allowTeaBreak !== gate.allowTeaBreak) data.allowTeaBreak = form.allowTeaBreak;
    if (Object.keys(data).length === 0) {
      onOpenChange(false);
      return;
    }
    try {
      await update.mutateAsync({ id: gate.id, data });
      toast({
        title: "Changes saved",
        description: usernameChanged ? "The new username signed this gate out everywhere." : undefined,
      });
      onOpenChange(false);
    } catch (err) {
      setError(errorText(err, "The changes could not be saved. Try again."));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={DIALOG} data-testid="gate-edit-dialog">
        <DialogHeader>
          <DialogTitle>Change {gate.name}</DialogTitle>
          <DialogDescription>To change the password, use Reset password.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3" noValidate>
          <Field label="Gate name" htmlFor={`${id}-name`}>
            <input
              id={`${id}-name`}
              value={form.name}
              onChange={(e) => patch({ name: e.target.value })}
              className={FIELD}
              data-testid="gate-form-name"
            />
          </Field>
          {!isBranchScoped && (
            <Field label="Branch" htmlFor={`${id}-branch`}>
              <select
                id={`${id}-branch`}
                value={form.branchId}
                onChange={(e) => patch({ branchId: e.target.value })}
                className={FIELD}
                data-testid="gate-form-branch"
              >
                {branches?.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Location (optional)" htmlFor={`${id}-location`}>
            <input
              id={`${id}-location`}
              value={form.location}
              onChange={(e) => patch({ location: e.target.value })}
              className={FIELD}
              data-testid="gate-form-location"
            />
          </Field>
          <Field
            label="Username"
            htmlFor={`${id}-username`}
            hint={
              usernameChanged ? (
                <span className="font-medium text-amber-700">
                  A new username signs this gate out everywhere. It signs in again with the new one.
                </span>
              ) : (
                "At least 3 characters, no spaces."
              )
            }
          >
            <input
              id={`${id}-username`}
              value={form.username}
              autoComplete="off"
              onChange={(e) => patch({ username: e.target.value })}
              className={cn(FIELD, "font-mono")}
              data-testid="gate-form-username"
            />
          </Field>
          <Field label="Notes (optional)" htmlFor={`${id}-notes`}>
            <textarea
              id={`${id}-notes`}
              value={form.notes}
              rows={2}
              onChange={(e) => patch({ notes: e.target.value })}
              className={cn(FIELD, "h-auto py-2 sm:h-auto")}
              data-testid="gate-form-notes"
            />
          </Field>
          <Toggle
            label="Takes gate passes"
            hint="Scans passes going out and coming back."
            checked={form.allowOutpass}
            onChange={(allowOutpass) => patch({ allowOutpass })}
            testId="gate-form-allow-outpass"
          />
          <Toggle
            label="Takes tea breaks"
            hint="Scans tea-break codes."
            checked={form.allowTeaBreak}
            onChange={(allowTeaBreak) => patch({ allowTeaBreak })}
            testId="gate-form-allow-tea"
          />
          <FormError message={error} />
          <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
            <GateButton onClick={() => onOpenChange(false)}>Cancel</GateButton>
            <GateButton tone="primary" type="submit" disabled={update.isPending} data-testid="gate-edit-submit">
              {update.isPending ? "Saving…" : "Save changes"}
            </GateButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Reset password ────────────────────────────────────────────────────────────

/** Sets a new password, then shows it once (with Copy) so it can be given to the gate. */
export function ResetPasswordDialog({
  gate,
  open,
  onOpenChange,
}: {
  gate: ManagedGate;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const id = useId();
  const update = useUpdateManagedGate();
  const [password, setPassword] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setPassword("");
      setDone(null);
      setError(null);
    }
  }, [open, gate.id]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const problem = passwordProblem(password);
    if (problem) return setError(problem);
    try {
      await update.mutateAsync({ id: gate.id, data: { password } });
      setDone(password);
      setPassword("");
    } catch (err) {
      setError(errorText(err, "The password could not be changed. Try again."));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={DIALOG} data-testid="gate-reset-dialog">
        <DialogHeader>
          <DialogTitle>Reset the password of {gate.name}</DialogTitle>
          <DialogDescription>
            {done
              ? "Give this password to the gate. Every browser that was signed in to this gate has been signed out."
              : "Every browser signed in to this gate is signed out and signs in again with the new password."}
          </DialogDescription>
        </DialogHeader>
        {done ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">New password</p>
                <p
                  className="truncate font-mono text-base font-semibold text-slate-900"
                  data-testid="gate-new-password"
                >
                  {done}
                </p>
              </div>
              <CopyButton value={done} what="Password" label="Copy the new password" testId="gate-new-password-copy" />
            </div>
            <div className="flex justify-end">
              <GateButton tone="primary" onClick={() => onOpenChange(false)} data-testid="gate-reset-done">
                Done
              </GateButton>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3" noValidate>
            <Field label="New password" hint="At least 6 characters." htmlFor={`${id}-password`}>
              <PasswordInput
                id={`${id}-password`}
                value={password}
                onChange={setPassword}
                testId="gate-reset-password"
              />
            </Field>
            <FormError message={error} />
            <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
              <GateButton onClick={() => onOpenChange(false)}>Cancel</GateButton>
              <GateButton
                tone="primary"
                type="submit"
                icon={KeyRound}
                disabled={update.isPending}
                data-testid="gate-reset-submit"
              >
                {update.isPending ? "Setting…" : "Set new password"}
              </GateButton>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Confirm ───────────────────────────────────────────────────────────────────

/** "Are you sure?" with the words of the action on its button; `extra` adds a softer way out (Switch off instead). */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  danger = false,
  busy = false,
  onConfirm,
  extra,
  testId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  extra?: ReactNode;
  testId?: string;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className={DIALOG} data-testid={testId}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm text-slate-600">{description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="gap-2 sm:space-x-0">
          <GateButton onClick={() => onOpenChange(false)}>Cancel</GateButton>
          {extra}
          <GateButton
            tone={danger ? "danger" : "primary"}
            onClick={onConfirm}
            disabled={busy}
            data-testid={testId ? `${testId}-confirm` : undefined}
          >
            {confirmLabel}
          </GateButton>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
