import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { Eye, EyeOff, KeyRound, Shuffle } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  useCreateManagedDesk,
  useUpdateManagedDesk,
  type DeskUpdateInput,
  type ManagedDesk,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { CopyButton, FIELD, GateButton } from "../../gates/parts";
import { errorText, generatePassword, passwordProblem, usernameProblem } from "./logic";

export { ConfirmDialog } from "../../gates/GateDialogs";

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

/** A password box with Show / Hide and "Suggest" (a random, easy-to-read password). */
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

// ── Add desk ──────────────────────────────────────────────────────────────────

const EMPTY_FORM = { name: "", branchId: "", location: "", username: "", password: "", notes: "" };

export function AddDeskDialog({
  open,
  onOpenChange,
  isBranchScoped,
  branches,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isBranchScoped: boolean;
  branches: readonly Branch[] | undefined;
  onAdded: (desk: ManagedDesk) => void;
}) {
  const id = useId();
  const { toast } = useToast();
  const create = useCreateManagedDesk();
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);

  // a fresh form each time it opens (not when the branch list refreshes while someone types)
  useEffect(() => {
    if (open) {
      setForm({ ...EMPTY_FORM, branchId: branches?.length === 1 ? String(branches[0].id) : "" });
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  // the branch list came after the dialog opened: one branch is chosen for them
  useEffect(() => {
    if (open && !form.branchId && branches?.length === 1) setForm((f) => ({ ...f, branchId: String(branches[0].id) }));
  }, [open, form.branchId, branches]);

  const patch = (p: Partial<typeof EMPTY_FORM>) => setForm((f) => ({ ...f, ...p }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const problem =
      (!form.name.trim() && "Give the desk a name.") ||
      (!isBranchScoped && !form.branchId && "Choose the branch of this desk.") ||
      usernameProblem(form.username) ||
      passwordProblem(form.password);
    if (problem) return setError(problem);
    try {
      const desk = await create.mutateAsync({
        name: form.name.trim(),
        branchId: !isBranchScoped && form.branchId ? Number(form.branchId) : undefined,
        username: form.username.trim(),
        password: form.password,
        location: form.location.trim() || null,
        notes: form.notes.trim() || null,
      });
      toast({ title: "Desk added", description: `${desk.name} can now sign in at the desk sign-in address.` });
      onOpenChange(false);
      onAdded(desk);
    } catch (err) {
      setError(errorText(err, "The desk could not be added. Try again."));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={DIALOG} data-testid="desk-add-dialog">
        <DialogHeader>
          <DialogTitle>Add a reception desk</DialogTitle>
          <DialogDescription>
            The desk signs in at the desk sign-in address with this username and password.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3" noValidate>
          <Field label="Desk name" htmlFor={`${id}-name`}>
            <input
              id={`${id}-name`}
              value={form.name}
              onChange={(e) => patch({ name: e.target.value })}
              className={FIELD}
              placeholder="Front Desk"
              data-testid="desk-form-name"
            />
          </Field>
          {!isBranchScoped && (
            <Field label="Branch" htmlFor={`${id}-branch`}>
              <select
                id={`${id}-branch`}
                value={form.branchId}
                onChange={(e) => patch({ branchId: e.target.value })}
                className={FIELD}
                data-testid="desk-form-branch"
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
              placeholder="Main lobby, ground floor"
              data-testid="desk-form-location"
            />
          </Field>
          <Field label="Username" hint="At least 3 characters, no spaces." htmlFor={`${id}-username`}>
            <input
              id={`${id}-username`}
              value={form.username}
              autoComplete="off"
              onChange={(e) => patch({ username: e.target.value })}
              className={cn(FIELD, "font-mono")}
              placeholder="front.desk"
              data-testid="desk-form-username"
            />
          </Field>
          <Field label="Password" hint="At least 6 characters." htmlFor={`${id}-password`}>
            <PasswordInput
              id={`${id}-password`}
              value={form.password}
              onChange={(password) => patch({ password })}
              testId="desk-form-password"
            />
          </Field>
          <Field label="Notes (optional)" htmlFor={`${id}-notes`}>
            <textarea
              id={`${id}-notes`}
              value={form.notes}
              rows={2}
              onChange={(e) => patch({ notes: e.target.value })}
              className={cn(FIELD, "h-auto py-2 sm:h-auto")}
              data-testid="desk-form-notes"
            />
          </Field>
          <FormError message={error} />
          <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
            <GateButton onClick={() => onOpenChange(false)}>Cancel</GateButton>
            <GateButton tone="primary" type="submit" disabled={create.isPending} data-testid="desk-add-submit">
              {create.isPending ? "Adding…" : "Add desk"}
            </GateButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Edit desk ─────────────────────────────────────────────────────────────────

export function EditDeskDialog({
  desk,
  open,
  onOpenChange,
  isBranchScoped,
  branches,
}: {
  desk: ManagedDesk;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isBranchScoped: boolean;
  branches: readonly Branch[] | undefined;
}) {
  const id = useId();
  const { toast } = useToast();
  const update = useUpdateManagedDesk();
  const start = () => ({
    name: desk.name,
    branchId: desk.branchId ? String(desk.branchId) : "",
    location: desk.location ?? "",
    username: desk.username,
    notes: desk.notes ?? "",
  });
  const [form, setForm] = useState(start);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setForm(start());
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, desk.id]);

  const patch = (p: Partial<ReturnType<typeof start>>) => setForm((f) => ({ ...f, ...p }));
  const usernameChanged = form.username.trim().toLowerCase() !== desk.username.toLowerCase();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const problem = (!form.name.trim() && "The desk needs a name.") || usernameProblem(form.username);
    if (problem) return setError(problem);
    const data: DeskUpdateInput = {};
    if (form.name.trim() !== desk.name) data.name = form.name.trim();
    if (!isBranchScoped && form.branchId && Number(form.branchId) !== desk.branchId)
      data.branchId = Number(form.branchId);
    if (form.username.trim() !== desk.username) data.username = form.username.trim();
    if ((form.location.trim() || null) !== desk.location) data.location = form.location.trim() || null;
    if ((form.notes.trim() || null) !== desk.notes) data.notes = form.notes.trim() || null;
    if (Object.keys(data).length === 0) {
      onOpenChange(false);
      return;
    }
    try {
      await update.mutateAsync({ id: desk.id, data });
      toast({
        title: "Changes saved",
        description: usernameChanged ? "The new username signed this desk out everywhere." : undefined,
      });
      onOpenChange(false);
    } catch (err) {
      setError(errorText(err, "The changes could not be saved. Try again."));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={DIALOG} data-testid="desk-edit-dialog">
        <DialogHeader>
          <DialogTitle>Change {desk.name}</DialogTitle>
          <DialogDescription>To change the password, use Reset password.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3" noValidate>
          <Field label="Desk name" htmlFor={`${id}-name`}>
            <input
              id={`${id}-name`}
              value={form.name}
              onChange={(e) => patch({ name: e.target.value })}
              className={FIELD}
              data-testid="desk-form-name"
            />
          </Field>
          {!isBranchScoped && (
            <Field label="Branch" htmlFor={`${id}-branch`}>
              <select
                id={`${id}-branch`}
                value={form.branchId}
                onChange={(e) => patch({ branchId: e.target.value })}
                className={FIELD}
                data-testid="desk-form-branch"
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
              data-testid="desk-form-location"
            />
          </Field>
          <Field
            label="Username"
            htmlFor={`${id}-username`}
            hint={
              usernameChanged ? (
                <span className="font-medium text-amber-700">
                  A new username signs this desk out everywhere. It signs in again with the new one.
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
              data-testid="desk-form-username"
            />
          </Field>
          <Field label="Notes (optional)" htmlFor={`${id}-notes`}>
            <textarea
              id={`${id}-notes`}
              value={form.notes}
              rows={2}
              onChange={(e) => patch({ notes: e.target.value })}
              className={cn(FIELD, "h-auto py-2 sm:h-auto")}
              data-testid="desk-form-notes"
            />
          </Field>
          <FormError message={error} />
          <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
            <GateButton onClick={() => onOpenChange(false)}>Cancel</GateButton>
            <GateButton tone="primary" type="submit" disabled={update.isPending} data-testid="desk-edit-submit">
              {update.isPending ? "Saving…" : "Save changes"}
            </GateButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Reset password ────────────────────────────────────────────────────────────

/** Sets a new password, then shows it once (with Copy) so it can be given to the desk. */
export function ResetDeskPasswordDialog({
  desk,
  open,
  onOpenChange,
}: {
  desk: ManagedDesk;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const id = useId();
  const update = useUpdateManagedDesk();
  const [password, setPassword] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setPassword("");
      setDone(null);
      setError(null);
    }
  }, [open, desk.id]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const problem = passwordProblem(password);
    if (problem) return setError(problem);
    try {
      await update.mutateAsync({ id: desk.id, data: { password } });
      setDone(password);
      setPassword("");
    } catch (err) {
      setError(errorText(err, "The password could not be changed. Try again."));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={DIALOG} data-testid="desk-reset-dialog">
        <DialogHeader>
          <DialogTitle>Reset the password of {desk.name}</DialogTitle>
          <DialogDescription>
            {done
              ? "Give this password to the desk. Every browser that was signed in to this desk has been signed out."
              : "Every browser signed in to this desk is signed out and signs in again with the new password."}
          </DialogDescription>
        </DialogHeader>
        {done ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">New password</p>
                <p
                  className="truncate font-mono text-base font-semibold text-slate-900"
                  data-testid="desk-new-password"
                >
                  {done}
                </p>
              </div>
              <CopyButton value={done} what="Password" label="Copy the new password" testId="desk-new-password-copy" />
            </div>
            <div className="flex justify-end">
              <GateButton tone="primary" onClick={() => onOpenChange(false)} data-testid="desk-reset-done">
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
                testId="desk-reset-password"
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
                data-testid="desk-reset-submit"
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
