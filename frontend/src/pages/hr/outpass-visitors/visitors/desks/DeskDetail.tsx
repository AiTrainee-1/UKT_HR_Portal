import { useEffect, useState } from "react";
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
  useDeleteManagedDesk,
  useManagedDesk,
  useRevealDeskPassword,
  useSignOutDesk,
  useUpdateManagedDesk,
  type ManagedDeskDetail,
} from "@/lib/api-client/custom-hooks";
import { fmtCount, fmtDate, fmtDateTime, fmtWhen, NONE, StatusChip } from "../../kit";
import { CopyButton, Fact, FLAT_SWITCH, GateButton, Panel } from "../../gates/parts";
import { ConfirmDialog, EditDeskDialog, ResetDeskPasswordDialog } from "./DeskDialogs";
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
function DeskLogin({
  desk,
  canEdit,
  canSeePassword,
  signInUrl,
  onReset,
}: {
  desk: ManagedDeskDetail;
  canEdit: boolean;
  canSeePassword: boolean;
  signInUrl: string;
  onReset: () => void;
}) {
  const { toast } = useToast();
  const reveal = useRevealDeskPassword();
  const [shown, setShown] = useState<{ id: number; password: string } | null>(null);
  const [notStored, setNotStored] = useState(false);

  // a different desk, or a password that changed: back to dots
  useEffect(() => {
    setShown(null);
    setNotStored(false);
  }, [desk.id, desk.updatedAt]);

  useEffect(() => {
    if (!shown) return;
    const timer = setTimeout(() => setShown(null), REVEAL_FOR_MS);
    return () => clearTimeout(timer);
  }, [shown]);

  const fetchPassword = async (): Promise<string | null> => {
    if (shown?.id === desk.id) return shown.password;
    try {
      const { password } = await reveal.mutateAsync(desk.id);
      setShown({ id: desk.id, password });
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

  const viewable = desk.passwordViewable && !notStored;
  const visible = shown?.id === desk.id ? shown.password : null;

  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-1.5">
          <ShieldCheck size={15} className="text-primary" aria-hidden="true" /> Desk login
        </span>
      }
      hint={
        <>
          Signs in at <span className="break-all font-mono">{signInUrl}</span>
        </>
      }
      testId="desk-login"
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="flex min-w-0 items-center justify-between gap-2 rounded-xl border border-slate-200/80 px-3 py-2">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Username</p>
            <p className="truncate font-mono text-sm font-semibold text-slate-900" data-testid="desk-username">
              {desk.username}
            </p>
          </div>
          <CopyButton value={desk.username} what="Username" label="Copy the username" testId="desk-username-copy" />
        </div>
        <div className="flex min-w-0 items-center justify-between gap-2 rounded-xl border border-slate-200/80 px-3 py-2">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Password</p>
            <p
              className="truncate font-mono text-sm font-semibold text-slate-900"
              data-testid="desk-password"
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
                data-testid="desk-password-view"
              >
                {visible ? "Hide" : "View"}
              </GateButton>
              <CopyButton value={fetchPassword} what="Password" label="Copy the password" testId="desk-password-copy" />
            </div>
          )}
        </div>
      </div>
      <p className="mt-2 text-xs text-slate-500" data-testid="desk-password-note">
        {!viewable ? (
          <>
            Not stored for desks created before 18 Nov 2026: set a new password to see it.{" "}
            {canEdit && (
              <button
                type="button"
                onClick={onReset}
                className="font-semibold text-primary underline-offset-2 hover:underline"
                data-testid="desk-password-set-new"
              >
                Reset password
              </button>
            )}
          </>
        ) : canSeePassword ? (
          "Only people with edit access can see it. Every view is recorded."
        ) : (
          "Only people allowed to see desk passwords can view it."
        )}
      </p>
    </Panel>
  );
}

/**
 * The right column for one desk: its header (name, branch, location, on / off switch, Edit, Reset password, Sign out
 * everywhere, Delete), its login, the browsers signed in to it and its counts. A View-only role sees all of it without
 * the buttons that change something.
 */
export function DeskDetail({
  deskId,
  canEdit,
  canSeePassword,
  isBranchScoped,
  branches,
  signInUrl,
  onDeleted,
  onBack,
}: {
  deskId: number;
  canEdit: boolean;
  canSeePassword: boolean;
  isBranchScoped: boolean;
  branches: readonly Branch[] | undefined;
  signInUrl: string;
  onDeleted: () => void;
  onBack: () => void;
}) {
  const { toast } = useToast();
  const { data: desk, isLoading, isError, refetch } = useManagedDesk(deskId);
  const update = useUpdateManagedDesk();
  const signOut = useSignOutDesk();
  const remove = useDeleteManagedDesk();
  const [dialog, setDialog] = useState<null | "edit" | "reset" | "signout" | "delete" | "switchoff">(null);
  const close = (open: boolean) => !open && setDialog(null);

  useEffect(() => setDialog(null), [deskId]);

  if (isLoading || (!desk && !isError)) {
    return (
      <div className="space-y-3" data-testid="desk-detail" aria-busy="true">
        <span className="sr-only" role="status">
          Loading…
        </span>
        <Skeleton className="h-28 w-full rounded-2xl" />
        <Skeleton className="h-36 w-full rounded-2xl" />
      </div>
    );
  }
  if (!desk) {
    return (
      <div
        role="alert"
        className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700"
        data-testid="desk-detail"
      >
        This desk could not be loaded. It may have been deleted, or it belongs to another branch.{" "}
        <button type="button" className="font-semibold underline" onClick={() => void refetch()}>
          Try again
        </button>
      </div>
    );
  }

  const save = async (data: Parameters<typeof update.mutateAsync>[0]["data"], done: string, description?: string) => {
    try {
      await update.mutateAsync({ id: desk.id, data });
      toast({ title: done, description });
      return true;
    } catch (err) {
      toast({ title: "Not saved", description: errorText(err, "Try again."), variant: "destructive" });
      return false;
    }
  };

  const switchOff = async () => {
    const signedIn = desk.activeSessions;
    if (await save({ isActive: false }, "Desk switched off", signedIn ? "It was signed out everywhere." : undefined))
      setDialog(null);
  };

  const signOutEverywhere = async () => {
    try {
      const { signedOut } = await signOut.mutateAsync(desk.id);
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

  const deleteDesk = async () => {
    try {
      await remove.mutateAsync(desk.id);
      toast({ title: "Desk deleted", description: `${desk.name} can no longer sign in.` });
      setDialog(null);
      onDeleted();
    } catch (err) {
      toast({ title: "Could not delete", description: errorText(err, "Try again."), variant: "destructive" });
    }
  };

  const counts = desk.counts;
  const busy = update.isPending || signOut.isPending || remove.isPending;

  return (
    <div className="min-w-0 space-y-3" data-testid="desk-detail">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex h-11 items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-slate-900 lg:hidden"
        data-testid="desk-back"
      >
        <ArrowLeft size={15} aria-hidden="true" /> All desks
      </button>

      <Panel testId="desk-header">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h3 className="min-w-0 truncate text-xl font-bold text-slate-900" data-testid="desk-name">
                {desk.name}
              </h3>
              {desk.branchName && (
                <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600">
                  {desk.branchName}
                </span>
              )}
              {!canEdit && (
                <StatusChip tone={desk.isActive ? "teal" : "slate"}>
                  {desk.isActive ? "Switched on" : "Switched off"}
                </StatusChip>
              )}
            </div>
            <p className="mt-0.5 flex items-center gap-1 text-sm text-slate-500">
              <MapPin size={13} aria-hidden="true" />
              <span className="truncate">{desk.location || "No location added"}</span>
            </p>
          </div>
          {canEdit && (
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex h-11 items-center gap-2 rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-700 sm:h-9">
                {desk.isActive ? "Switched on" : "Switched off"}
                <Switch
                  className={FLAT_SWITCH}
                  checked={desk.isActive}
                  disabled={busy}
                  aria-label={desk.isActive ? "Switch this desk off" : "Switch this desk on"}
                  onCheckedChange={(on) =>
                    on
                      ? void save({ isActive: true }, "Desk switched on", "It can sign in again.")
                      : setDialog("switchoff")
                  }
                  data-testid="desk-active"
                />
              </label>
              <GateButton icon={Pencil} onClick={() => setDialog("edit")} data-testid="desk-edit">
                Edit
              </GateButton>
              <GateButton icon={KeyRound} onClick={() => setDialog("reset")} data-testid="desk-reset">
                Reset password
              </GateButton>
              <GateButton icon={LogOut} onClick={() => setDialog("signout")} data-testid="desk-signout">
                Sign out everywhere
              </GateButton>
              <GateButton tone="danger" icon={Trash2} onClick={() => setDialog("delete")} data-testid="desk-delete">
                Delete
              </GateButton>
            </div>
          )}
        </div>
        {!desk.isActive && (
          <p className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
            This desk is switched off: it cannot sign in until it is switched on again.
          </p>
        )}
        {desk.notes && (
          <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600" data-testid="desk-notes">
            {desk.notes}
          </p>
        )}
      </Panel>

      <DeskLogin
        desk={desk}
        canEdit={canEdit}
        canSeePassword={canSeePassword}
        signInUrl={signInUrl}
        onReset={() => setDialog("reset")}
      />

      <div className="grid gap-3 xl:grid-cols-2">
        <Panel title="Since it was added" testId="desk-counts">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Fact label="Check-ins" testId="desk-count-check-ins">
              {fmtCount(counts.checkIns)}
            </Fact>
            <Fact label="Check-outs" testId="desk-count-check-outs">
              {fmtCount(counts.checkOuts)}
            </Fact>
            <Fact label="Today" testId="desk-count-today">
              {fmtCount(counts.today)}
            </Fact>
            <Fact label="All records" testId="desk-count-total">
              {fmtCount(counts.total)}
            </Fact>
            <Fact label="Last sign-in" testId="desk-count-last-login">
              <span className="text-sm">{when(desk.lastLoginAt)}</span>
            </Fact>
            <Fact label="Created" testId="desk-count-created">
              <span className="block truncate text-sm" title={desk.createdBy ?? undefined}>
                {desk.createdBy ?? NONE}
              </span>
              <span className="block text-[11px] font-normal text-slate-500">
                {fmtDate(desk.createdAt, { year: true })}
              </span>
            </Fact>
          </div>
          {desk.updatedBy && desk.updatedAt && (
            <p className="mt-2 text-xs text-slate-500">
              Last changed by {desk.updatedBy}, {fmtDateTime(desk.updatedAt, { year: true })}.
            </p>
          )}
        </Panel>

        <Panel
          title="Signed in on"
          hint="Browsers showing this desk's console now."
          actions={
            canEdit && desk.sessions.length > 0 ? (
              <GateButton small icon={LogOut} onClick={() => setDialog("signout")} className="px-2.5 text-xs">
                Sign out all
              </GateButton>
            ) : undefined
          }
          testId="desk-sessions"
        >
          {desk.sessions.length === 0 ? (
            <p className="text-sm text-slate-500">Not signed in anywhere.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {desk.sessions.map((s) => {
                const online = isOnline(s.lastSeenAt);
                return (
                  <li key={s.id} className="flex items-center gap-2.5 py-2" data-testid={`desk-session-${s.id}`}>
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

      {canEdit && (
        <>
          <EditDeskDialog
            desk={desk}
            open={dialog === "edit"}
            onOpenChange={close}
            isBranchScoped={isBranchScoped}
            branches={branches}
          />
          <ResetDeskPasswordDialog desk={desk} open={dialog === "reset"} onOpenChange={close} />
          <ConfirmDialog
            open={dialog === "signout"}
            onOpenChange={close}
            title={`Sign ${desk.name} out everywhere?`}
            description={
              <p>
                Every browser showing this desk goes back to the desk sign-in page and has to sign in again with the
                username and password.
              </p>
            }
            confirmLabel="Sign out everywhere"
            busy={signOut.isPending}
            onConfirm={() => void signOutEverywhere()}
            testId="desk-signout-confirm"
          />
          <ConfirmDialog
            open={dialog === "switchoff"}
            onOpenChange={close}
            title={`Switch ${desk.name} off?`}
            description={
              <p>
                It is signed out at once and cannot sign in until you switch it on again. Its visitors stay on the
                Visitors page.
              </p>
            }
            confirmLabel="Switch off"
            busy={update.isPending}
            onConfirm={() => void switchOff()}
            testId="desk-switchoff-confirm"
          />
          <ConfirmDialog
            open={dialog === "delete"}
            onOpenChange={close}
            title={`Delete ${desk.name}?`}
            description={
              <>
                <p>
                  This cannot be undone. Its login stops working. The {fmtCount(counts.total)} visits it checked in or
                  out stay on the Visitors page, but no longer count for a desk here.
                </p>
                {desk.isActive && (
                  <p className="font-medium text-slate-700">
                    To stop it for now, switch it off instead: you can switch it on again later.
                  </p>
                )}
              </>
            }
            confirmLabel="Delete desk"
            danger
            busy={remove.isPending}
            onConfirm={() => void deleteDesk()}
            extra={
              desk.isActive ? (
                <GateButton onClick={() => setDialog("switchoff")} data-testid="desk-delete-switchoff">
                  Switch off instead
                </GateButton>
              ) : undefined
            }
            testId="desk-delete-confirm"
          />
        </>
      )}
    </div>
  );
}
