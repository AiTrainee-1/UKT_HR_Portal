import { useCallback, useEffect, useMemo, useState } from "react";
import { Redirect, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { CalendarRange, ClipboardList, LogOut, UserCheck, UserPlus, UsersRound } from "lucide-react";
import { useUrlParams } from "@/components/payroll/kit/url-state";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { UktLogoMark } from "@/components/ui/UktLogoMark";
import { useToast } from "@/hooks/use-toast";
import type { GateRange, VisitorVisit } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { DataTable } from "@/pages/hr/outpass-visitors/kit/DataTable";
import { ExportButton } from "@/pages/hr/outpass-visitors/kit/ExportButton";
import { StatRow, StatTile } from "@/pages/hr/outpass-visitors/kit/StatTile";
import { CheckOutDialog } from "@/pages/hr/outpass-visitors/visitors/CheckOutDialog";
import {
  DESK_SIGN_IN,
  DeskError,
  deskExport,
  deskLogout,
  deskMe,
  hasDeskSession,
  sessionEnded,
  setDeskNavigator,
  storedDeskName,
  useDeskCheckOut,
  useDeskSummary,
  useDeskVisits,
  type DeskInfo,
} from "./desk-api";
import { DeskRecordsView } from "./DeskRecordsView";
import { DeskRegisterDialog } from "./DeskRegisterDialog";
import { visitColumns } from "./visit-columns";

/**
 * The reception desk's console (/reception/console): its own sign-in, never an HR one (desk-api.ts). Today's visitors of
 * the desk's branch (or this week's / this month's), whom they came to see and whether that person was told, a Check out
 * button for every visitor still inside, Register visitor for a walk-in, and a Records view (any dates, status, search,
 * Excel / PDF). The session is checked on load, every 5 minutes, whenever the tab comes back into view and when the
 * network returns (GET me, which also renews the token); when it is over, desk-api.ts clears the desk keys and sends the
 * browser to /reception-login with the reason. Sign out ends this session on the server and lands on /reception-login,
 * never on "/" or an HR page.
 */

/** GET me this often (and on the tab coming back): it keeps the token fresh and notices a sign-out from HR. */
export const HEARTBEAT_MS = 5 * 60_000;
const RANGE_LABEL: Record<GateRange, string> = { today: "Today", week: "This week", month: "This month" };
const PAGE_SIZE = 15;
const VIEW_DEFAULTS = { view: "visits" };

export default function ReceptionConsole() {
  if (!hasDeskSession()) return <Redirect to={DESK_SIGN_IN} replace />;
  return <DeskConsole />;
}

function DeskConsole() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [{ view }, setView] = useUrlParams(VIEW_DEFAULTS);
  const [desk, setDesk] = useState<DeskInfo | null>(null);
  const [range, setRange] = useState<GateRange>("today");
  const [page, setPage] = useState(1);
  const [target, setTarget] = useState<VisitorVisit | null>(null);
  const [shownAadhaar, setShownAadhaar] = useState<number | null>(null);
  const [registering, setRegistering] = useState(false);
  const [confirmOut, setConfirmOut] = useState(false);

  // a session that ends while this page is open goes to the sign-in through the router (no reload)
  useEffect(() => {
    setDeskNavigator((to) => navigate(to, { replace: true }));
    return () => setDeskNavigator(null);
  }, [navigate]);

  // another desk signing in on this browser later must not see this desk's cached rows
  useEffect(() => () => queryClient.removeQueries({ queryKey: ["reception-desk"] }), [queryClient]);

  // the heartbeat: on load, every 5 minutes, when the tab is shown again, when the network comes back
  useEffect(() => {
    let stopped = false;
    const beat = async () => {
      try {
        const me = await deskMe();
        if (!stopped) setDesk(me.desk);
      } catch {
        /* an ended session is already on its way to the sign-in; no connection: the next beat tries again */
      }
    };
    void beat();
    const timer = setInterval(() => void beat(), HEARTBEAT_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void beat();
    };
    const onOnline = () => void beat();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, []);

  const records = view === "records";
  const summary = useDeskSummary();
  const visits = useDeskVisits(range, page, PAGE_SIZE, !records);
  const checkOut = useDeskCheckOut();

  const refresh = useCallback(() => queryClient.invalidateQueries({ queryKey: ["reception-desk"] }), [queryClient]);

  const confirmCheckOut = async (note: string) => {
    const visit = target;
    if (!visit) return;
    try {
      await checkOut.mutateAsync({ id: visit.id, note: note || undefined });
    } catch (err) {
      if (sessionEnded(err)) {
        setTarget(null);
        return; // on its way to the sign-in page
      }
      void refresh();
      throw new Error(err instanceof DeskError ? err.message : "Could not check out. Please try again.");
    }
    setTarget(null);
    toast({ title: `${visit.name} is checked out` });
    await refresh();
  };

  const signOut = async () => {
    setConfirmOut(false);
    await deskLogout();
    queryClient.removeQueries({ queryKey: ["reception-desk"] });
    navigate(DESK_SIGN_IN, { replace: true });
  };

  const exportRange = async (format: "xlsx" | "pdf") => {
    try {
      const filename = await deskExport(format, { range });
      toast({ title: "File downloaded", description: filename });
    } catch (err) {
      if (sessionEnded(err)) return;
      throw err;
    }
  };

  const now = new Date();
  const columns = useMemo(
    () =>
      visitColumns({
        now,
        shownAadhaar,
        onToggleAadhaar: (id) => setShownAadhaar((cur) => (cur === id ? null : id)),
        onCheckOut: setTarget,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shownAadhaar, visits.data],
  );

  const deskName = desk?.name ?? storedDeskName() ?? "Reception";
  const s = summary.data;
  const visitsError = visits.isError && !sessionEnded(visits.error) ? (visits.error as Error).message : null;

  return (
    <div className="flex min-h-screen min-w-0 flex-col bg-slate-50" data-testid="reception-console">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white">
              <UktLogoMark className="h-7" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                UK Textiles HRMS · Reception
              </p>
              <h1 className="truncate text-lg font-bold leading-tight text-slate-900" data-testid="reception-desk-name">
                {deskName}
                {desk?.branchName && <span className="font-medium text-slate-500"> · {desk.branchName}</span>}
              </h1>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setRegistering(true)}
              className="inline-flex h-11 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-sm font-semibold text-primary-foreground hover:opacity-90"
              data-testid="reception-register"
            >
              <UserPlus size={15} aria-hidden="true" /> Register visitor
            </button>
            <button
              type="button"
              onClick={() => setConfirmOut(true)}
              className="inline-flex h-11 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
              data-testid="reception-sign-out"
            >
              <LogOut size={15} aria-hidden="true" /> Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full min-w-0 max-w-7xl flex-1 flex-col gap-4 p-4">
        <StatRow columns={4}>
          <StatTile label="Inside now" value={s?.insideNow} icon={UserCheck} tone="amber" loading={!s} />
          <StatTile label="Today" value={s?.today} icon={UsersRound} loading={!s} />
          <StatTile label="Checked out today" value={s?.checkedOutToday} icon={LogOut} tone="teal" loading={!s} />
          <StatTile label="This month" value={s?.thisMonth} icon={CalendarRange} tone="slate" loading={!s} />
        </StatRow>

        <div
          className="flex w-full overflow-hidden rounded-lg border border-slate-200 bg-white sm:w-auto sm:self-start"
          role="group"
          aria-label="Screen"
        >
          {(
            [
              { value: "visits", label: "Visitors", icon: UsersRound },
              { value: "records", label: "Records", icon: ClipboardList },
            ] as const
          ).map((v, i) => {
            const on = (records ? "records" : "visits") === v.value;
            const Icon = v.icon;
            return (
              <button
                key={v.value}
                type="button"
                aria-pressed={on}
                onClick={() => setView({ view: v.value })}
                className={cn(
                  "inline-flex h-11 flex-1 items-center justify-center gap-2 px-4 text-sm font-semibold sm:flex-none",
                  i > 0 && "border-l border-slate-200",
                  on ? "bg-primary text-primary-foreground" : "text-slate-700 hover:bg-slate-50",
                )}
                data-testid={`reception-view-${v.value}`}
              >
                <Icon size={16} aria-hidden="true" /> {v.label}
              </button>
            );
          })}
        </div>

        {records ? (
          <DeskRecordsView onCheckOut={setTarget} />
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div
                role="group"
                aria-label="Dates"
                className="inline-flex max-w-full rounded-xl border border-slate-200 bg-white p-1"
              >
                {(Object.keys(RANGE_LABEL) as GateRange[]).map((r) => (
                  <button
                    key={r}
                    type="button"
                    aria-pressed={range === r}
                    onClick={() => {
                      setRange(r);
                      setPage(1);
                    }}
                    className={cn(
                      "h-11 rounded-lg px-3 text-sm font-semibold sm:h-8",
                      range === r ? "bg-primary text-primary-foreground" : "text-slate-600 hover:bg-slate-50",
                    )}
                    data-testid={`reception-range-${r}`}
                  >
                    {RANGE_LABEL[r]}
                  </button>
                ))}
              </div>
              <ExportButton
                title="Visitors"
                run={exportRange}
                label={`Export ${RANGE_LABEL[range].toLowerCase()}`}
                hints={{ xlsx: "These visitors of this branch", pdf: "These visitors of this branch" }}
                testId="reception-export"
              />
            </div>

            <DataTable
              columns={columns}
              rows={visits.data?.items}
              rowKey={(v) => v.id}
              loading={visits.isLoading || visits.isPlaceholderData}
              error={visitsError}
              onRetry={() => void visits.refetch()}
              caption="Visitors"
              testId="reception-visits"
              summary={
                <span className="font-semibold text-slate-800">
                  Visitors - {RANGE_LABEL[range]}
                  <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">
                    {visits.data?.total ?? 0}
                  </span>
                </span>
              }
              empty={{
                icon: UsersRound,
                title: `No visitors for ${RANGE_LABEL[range].toLowerCase()}`,
                hint: "Visitors appear here once they check in at the QR code, with HR or at this desk.",
              }}
              pagination={
                visits.data ? { page, pageSize: PAGE_SIZE, total: visits.data.total, onPageChange: setPage } : undefined
              }
            />
          </>
        )}
        <p className="text-center text-xs font-medium uppercase tracking-wide text-slate-500">
          You see only this branch's visitors.
        </p>
      </main>

      <DeskRegisterDialog
        open={registering}
        onClose={() => setRegistering(false)}
        onRegistered={(visit) => {
          setRegistering(false);
          toast({ title: `${visit.name} is checked in`, description: `Meeting ${visit.whomToMeet}` });
          void refresh();
        }}
      />

      <CheckOutDialog target={target} onClose={() => setTarget(null)} onConfirm={confirmCheckOut} />

      <AlertDialog open={confirmOut} onOpenChange={setConfirmOut}>
        <AlertDialogContent className="w-[calc(100%-2rem)] max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Sign out of {deskName}?</AlertDialogTitle>
            <AlertDialogDescription>
              This screen goes back to the reception sign-in until someone signs in again with the desk's username and
              password. Other screens signed in to this desk stay signed in.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Stay signed in</AlertDialogCancel>
            <AlertDialogAction onClick={() => void signOut()} data-testid="reception-sign-out-confirm">
              Sign out
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
