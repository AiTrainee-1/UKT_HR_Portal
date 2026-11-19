import { useEffect, useId, useState } from "react";
import {
  ArrowLeft,
  Eye,
  EyeOff,
  KeyRound,
  LogOut,
  MapPin,
  MonitorSmartphone,
  Pencil,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import {
  useDeleteManagedGate,
  useManagedGate,
  useRevealGatePassword,
  useSignOutGate,
  useUpdateManagedGate,
  type ManagedGateDetail,
} from "@/lib/api-client/custom-hooks";
import { fmtCount, fmtDate, fmtDateTime, fmtWhen, NONE, StatusChip } from "../kit";
import { ConfirmDialog, EditGateDialog, ResetPasswordDialog } from "./GateDialogs";
import { CopyButton, Fact, FLAT_SWITCH, GateButton, Panel } from "./parts";
import { errorText, isNotStored, isOnline } from "./logic";

/** How long a shown password stays on screen before it turns back into dots. */
const REVEAL_FOR_MS = 30_000;

type Branch = { id: number; name: string };

function when(value: string | null | undefined): string {
  if (!value) return NONE;
  const { time, date } = fmtWhen(value);
  return date ? `${date}, ${time}` : `Today, ${time}`;
}

/** Username + Copy, password dots + View + Copy, and what the viewer may or may not see. */
function GateLogin({
  gate,
  canEdit,
  canSeePassword,
  monitorUrl,
  onReset,
}: {
  gate: ManagedGateDetail;
  canEdit: boolean;
  canSeePassword: boolean;
  monitorUrl: string;
  onReset: () => void;
}) {
  const { toast } = useToast();
  const reveal = useRevealGatePassword();
  const [shown, setShown] = useState<{ id: number; password: string } | null>(null);
  const [notStored, setNotStored] = useState(false);

  // a different gate, or a password that changed: back to dots
  useEffect(() => {
    setShown(null);
    setNotStored(false);
  }, [gate.id, gate.updatedAt]);

  useEffect(() => {
    if (!shown) return;
    const timer = setTimeout(() => setShown(null), REVEAL_FOR_MS);
    return () => clearTimeout(timer);
  }, [shown]);

  const fetchPassword = async (): Promise<string | null> => {
    if (shown?.id === gate.id) return shown.password;
    try {
      const { password } = await reveal.mutateAsync(gate.id);
      setShown({ id: gate.id, password });
      return password;
    } catch (err) {
      if (isNotStored(err)) setNotStored(true);
      else
        toast({
          title: "Could not show the password",
          description: errorText(err, "Try again."),
          variant: "destructive",
        });
      return null;
    }
  };

  const viewable = gate.passwordViewable && !notStored;
  const visible = shown?.id === gate.id ? shown.password : null;

  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-1.5">
          <ShieldCheck size={15} className="text-primary" aria-hidden="true" /> Gate login
        </span>
      }
      hint={
        <>
          Signs in at <span className="break-all font-mono">{monitorUrl}</span>
        </>
      }
      testId="gate-login"
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="flex min-w-0 items-center justify-between gap-2 rounded-xl border border-slate-200/80 px-3 py-2">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Username</p>
            <p className="truncate font-mono text-sm font-semibold text-slate-900" data-testid="gate-username">
              {gate.username}
            </p>
          </div>
          <CopyButton value={gate.username} what="Username" label="Copy the username" testId="gate-username-copy" />
        </div>
        <div className="flex min-w-0 items-center justify-between gap-2 rounded-xl border border-slate-200/80 px-3 py-2">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Password</p>
            <p
              className="truncate font-mono text-sm font-semibold text-slate-900"
              data-testid="gate-password"
              aria-label={visible ? undefined : "Password hidden"}
            >
              {visible ?? "••••••••••"}
            </p>
          </div>
          {canSeePassword && viewable && (
            <div className="flex shrink-0 items-center">
              <GateButton
                small
                tone="ghost"
                icon={visible ? EyeOff : Eye}
                onClick={() => (visible ? setShown(null) : void fetchPassword())}
                disabled={reveal.isPending}
                aria-label={visible ? "Hide the password" : "View the password"}
                data-testid="gate-password-view"
              >
                {visible ? "Hide" : "View"}
              </GateButton>
              <CopyButton value={fetchPassword} what="Password" label="Copy the password" testId="gate-password-copy" />
            </div>
          )}
        </div>
      </div>
      <p className="mt-2 text-xs text-slate-500" data-testid="gate-password-note">
        {!viewable ? (
          <>
            Not stored for gates created before 18 Nov 2026: set a new password to see it.{" "}
            {canEdit && (
              <button
                type="button"
                onClick={onReset}
                className="font-semibold text-primary underline-offset-2 hover:underline"
                data-testid="gate-password-set-new"
              >
                Reset password
              </button>
            )}
          </>
        ) : canSeePassword ? (
          "Only people with edit access can see it. Every view is recorded."
        ) : (
          "Only people allowed to see gate passwords can view it."
        )}
      </p>
    </Panel>
  );
}

function Setting({
  label,
  hint,
  checked,
  canEdit,
  busy,
  onChange,
  testId,
}: {
  label: string;
  hint: string;
  checked: boolean;
  canEdit: boolean;
  busy: boolean;
  onChange: (next: boolean) => void;
  testId: string;
}) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <div className="min-w-0">
        <label htmlFor={id} className="block text-sm font-medium text-slate-800">
          {label}
        </label>
        <p className="text-xs text-slate-500">{hint}</p>
      </div>
      {canEdit ? (
        <Switch
          id={id}
          checked={checked}
          disabled={busy}
          onCheckedChange={onChange}
          data-testid={testId}
          className={FLAT_SWITCH}
        />
      ) : (
        <StatusChip tone={checked ? "teal" : "slate"} testId={testId}>
          {checked ? "Yes" : "No"}
        </StatusChip>
      )}
    </div>
  );
}

/**
 * The right column for one gate: its header (name, branch, location, on / off switch, Edit, Reset password, Sign out
 * everywhere, Delete), its login, what it takes, its counts and the browsers signed in to it. A View-only role sees all
 * of it without the buttons that change something.
 */
export function GateDetail({
  gateId,
  canEdit,
  canSeePassword,
  isBranchScoped,
  branches,
  monitorUrl,
  onDeleted,
  onBack,
}: {
  gateId: number;
  canEdit: boolean;
  canSeePassword: boolean;
  isBranchScoped: boolean;
  branches: readonly Branch[] | undefined;
  monitorUrl: string;
  onDeleted: () => void;
  onBack: () => void;
}) {
  const { toast } = useToast();
  const { data: gate, isLoading, isError, refetch } = useManagedGate(gateId);
  const update = useUpdateManagedGate();
  const signOut = useSignOutGate();
  const remove = useDeleteManagedGate();
  const [dialog, setDialog] = useState<null | "edit" | "reset" | "signout" | "delete" | "switchoff">(null);
  const close = (open: boolean) => !open && setDialog(null);

  useEffect(() => setDialog(null), [gateId]);

  if (isLoading || (!gate && !isError)) {
    return (
      <div className="space-y-3" data-testid="gate-detail" aria-busy="true">
        <span className="sr-only" role="status">
          Loading…
        </span>
        <Skeleton className="h-28 w-full rounded-2xl" />
        <Skeleton className="h-36 w-full rounded-2xl" />
      </div>
    );
  }
  if (!gate) {
    return (
      <div
        role="alert"
        className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700"
        data-testid="gate-detail"
      >
        This gate could not be loaded. It may have been deleted, or it belongs to another branch.{" "}
        <button type="button" className="font-semibold underline" onClick={() => void refetch()}>
          Try again
        </button>
      </div>
    );
  }

  const save = async (data: Parameters<typeof update.mutateAsync>[0]["data"], done: string, description?: string) => {
    try {
      await update.mutateAsync({ id: gate.id, data });
      toast({ title: done, description });
      return true;
    } catch (err) {
      toast({ title: "Not saved", description: errorText(err, "Try again."), variant: "destructive" });
      return false;
    }
  };

  const switchOff = async () => {
    const signedIn = gate.activeSessions;
    if (await save({ isActive: false }, "Gate switched off", signedIn ? "It was signed out everywhere." : undefined))
      setDialog(null);
  };

  const signOutEverywhere = async () => {
    try {
      const { signedOut } = await signOut.mutateAsync(gate.id);
      toast({
        title: "Signed out everywhere",
        description:
          signedOut === 0
            ? "No browser was signed in."
            : `${signedOut} ${signedOut === 1 ? "browser was" : "browsers were"} signed out.`,
      });
      setDialog(null);
    } catch (err) {
      toast({ title: "Could not sign out", description: errorText(err, "Try again."), variant: "destructive" });
    }
  };

  const deleteGate = async () => {
    try {
      await remove.mutateAsync(gate.id);
      toast({ title: "Gate deleted", description: `${gate.name} can no longer sign in.` });
      setDialog(null);
      onDeleted();
    } catch (err) {
      toast({ title: "Could not delete", description: errorText(err, "Try again."), variant: "destructive" });
    }
  };

  const counts = gate.counts;
  const busy = update.isPending || signOut.isPending || remove.isPending;

  return (
    <div className="min-w-0 space-y-3" data-testid="gate-detail">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex h-11 items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-slate-900 lg:hidden"
        data-testid="gate-back"
      >
        <ArrowLeft size={15} aria-hidden="true" /> All gates
      </button>

      <Panel testId="gate-header">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h3 className="min-w-0 truncate text-xl font-bold text-slate-900" data-testid="gate-name">
                {gate.name}
              </h3>
              {gate.branchName && (
                <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600">
                  {gate.branchName}
                </span>
              )}
              {!canEdit && (
                <StatusChip tone={gate.isActive ? "teal" : "slate"}>
                  {gate.isActive ? "Switched on" : "Switched off"}
                </StatusChip>
              )}
            </div>
            <p className="mt-0.5 flex items-center gap-1 text-sm text-slate-500">
              <MapPin size={13} aria-hidden="true" />
              <span className="truncate">{gate.location || "No location added"}</span>
            </p>
          </div>
          {canEdit && (
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex h-11 items-center gap-2 rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-700 sm:h-9">
                {gate.isActive ? "Switched on" : "Switched off"}
                <Switch
                  className={FLAT_SWITCH}
                  checked={gate.isActive}
                  disabled={busy}
                  aria-label={gate.isActive ? "Switch this gate off" : "Switch this gate on"}
                  onCheckedChange={(on) =>
                    on
                      ? void save({ isActive: true }, "Gate switched on", "It can sign in again.")
                      : setDialog("switchoff")
                  }
                  data-testid="gate-active"
                />
              </label>
              <GateButton icon={Pencil} onClick={() => setDialog("edit")} data-testid="gate-edit">
                Edit
              </GateButton>
              <GateButton icon={KeyRound} onClick={() => setDialog("reset")} data-testid="gate-reset">
                Reset password
              </GateButton>
              <GateButton icon={LogOut} onClick={() => setDialog("signout")} data-testid="gate-signout">
                Sign out everywhere
              </GateButton>
              <GateButton tone="danger" icon={Trash2} onClick={() => setDialog("delete")} data-testid="gate-delete">
                Delete
              </GateButton>
            </div>
          )}
        </div>
        {!gate.isActive && (
          <p className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
            This gate is switched off: it cannot sign in or scan until it is switched on again.
          </p>
        )}
      </Panel>

      <GateLogin
        gate={gate}
        canEdit={canEdit}
        canSeePassword={canSeePassword}
        monitorUrl={monitorUrl}
        onReset={() => setDialog("reset")}
      />

      <div className="grid gap-3 xl:grid-cols-2">
        <Panel title="What this gate scans" testId="gate-settings">
          <div className="divide-y divide-slate-100">
            <Setting
              label="Gate passes"
              hint="Passes going out and coming back."
              checked={gate.allowOutpass}
              canEdit={canEdit}
              busy={busy}
              onChange={(allowOutpass) =>
                void save(
                  { allowOutpass },
                  allowOutpass ? "Gate passes on at this gate" : "Gate passes off at this gate",
                )
              }
              testId="gate-allow-outpass"
            />
            <Setting
              label="Tea breaks"
              hint="Tea-break codes, out and in."
              checked={gate.allowTeaBreak}
              canEdit={canEdit}
              busy={busy}
              onChange={(allowTeaBreak) =>
                void save(
                  { allowTeaBreak },
                  allowTeaBreak ? "Tea breaks on at this gate" : "Tea breaks off at this gate",
                )
              }
              testId="gate-allow-tea"
            />
          </div>
          {gate.notes && (
            <p className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600" data-testid="gate-notes">
              {gate.notes}
            </p>
          )}
        </Panel>

        <Panel
          title="Signed in on"
          hint="Browsers showing this gate's monitor now."
          actions={
            canEdit && gate.sessions.length > 0 ? (
              <GateButton small icon={LogOut} onClick={() => setDialog("signout")} className="px-2.5 text-xs">
                Sign out all
              </GateButton>
            ) : undefined
          }
          testId="gate-sessions"
        >
          {gate.sessions.length === 0 ? (
            <p className="text-sm text-slate-500">Not signed in anywhere.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {gate.sessions.map((s) => {
                const online = isOnline(s.lastSeenAt);
                return (
                  <li key={s.id} className="flex items-center gap-2.5 py-2" data-testid={`gate-session-${s.id}`}>
                    <MonitorSmartphone size={16} className="shrink-0 text-slate-400" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-slate-800">{s.deviceLabel}</p>
                      <p className="truncate text-xs text-slate-500">
                        Signed in {fmtDateTime(s.createdAt)} · last seen{" "}
                        {s.lastSeenAt ? fmtDateTime(s.lastSeenAt) : NONE}
                      </p>
                    </div>
                    <StatusChip tone={online ? "teal" : "slate"}>{online ? "Online now" : "Idle"}</StatusChip>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title="Since it was added" testId="gate-counts">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
          <Fact label="Exits" testId="gate-count-exits">
            {fmtCount(counts.exits)}
          </Fact>
          <Fact label="Returns" testId="gate-count-returns">
            {fmtCount(counts.returns)}
          </Fact>
          <Fact label="Tea breaks" testId="gate-count-tea">
            {fmtCount(counts.teaOut)}
          </Fact>
          <Fact label="Denied" tone={counts.denied > 0 ? "rose" : undefined} testId="gate-count-denied">
            {fmtCount(counts.denied)}
          </Fact>
          <Fact label="Last sign-in" testId="gate-count-last-login">
            <span className="text-sm">{when(gate.lastLoginAt)}</span>
          </Fact>
          <Fact label="Created" testId="gate-count-created">
            <span className="block truncate text-sm" title={gate.createdBy ?? undefined}>
              {gate.createdBy ?? NONE}
            </span>
            <span className="block text-[11px] font-normal text-slate-500">
              {fmtDate(gate.createdAt, { year: true })}
            </span>
          </Fact>
        </div>
        {gate.updatedBy && gate.updatedAt && (
          <p className="mt-2 text-xs text-slate-500">
            Last changed by {gate.updatedBy}, {fmtDateTime(gate.updatedAt, { year: true })}.
          </p>
        )}
      </Panel>

      {canEdit && (
        <>
          <EditGateDialog
            gate={gate}
            open={dialog === "edit"}
            onOpenChange={close}
            isBranchScoped={isBranchScoped}
            branches={branches}
          />
          <ResetPasswordDialog gate={gate} open={dialog === "reset"} onOpenChange={close} />
          <ConfirmDialog
            open={dialog === "signout"}
            onOpenChange={close}
            title={`Sign ${gate.name} out everywhere?`}
            description={
              <p>
                Every browser showing this gate goes back to the sign-in page and has to sign in again with the username
                and password.
              </p>
            }
            confirmLabel="Sign out everywhere"
            busy={signOut.isPending}
            onConfirm={() => void signOutEverywhere()}
            testId="gate-signout-confirm"
          />
          <ConfirmDialog
            open={dialog === "switchoff"}
            onOpenChange={close}
            title={`Switch ${gate.name} off?`}
            description={
              <p>It is signed out at once and cannot sign in or scan until you switch it on again. Its records stay.</p>
            }
            confirmLabel="Switch off"
            busy={update.isPending}
            onConfirm={() => void switchOff()}
            testId="gate-switchoff-confirm"
          />
          <ConfirmDialog
            open={dialog === "delete"}
            onOpenChange={close}
            title={`Delete ${gate.name}?`}
            description={
              <>
                <p>
                  This cannot be undone. Its login stops working and its {fmtCount(counts.total)} records stay, but
                  under &ldquo;Removed gate&rdquo; instead of its name.
                </p>
                {gate.isActive && (
                  <p className="font-medium text-slate-700">
                    To stop it for now, switch it off instead: you can switch it on again later.
                  </p>
                )}
              </>
            }
            confirmLabel="Delete gate"
            danger
            busy={remove.isPending}
            onConfirm={() => void deleteGate()}
            extra={
              gate.isActive ? (
                <GateButton onClick={() => setDialog("switchoff")} data-testid="gate-delete-switchoff">
                  Switch off instead
                </GateButton>
              ) : undefined
            }
            testId="gate-delete-confirm"
          />
        </>
      )}
    </div>
  );
}
