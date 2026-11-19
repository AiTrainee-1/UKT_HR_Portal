// The gate monitor console (/gatemonitor/console): one top bar (the gate, its branch, the connection, the time, Sign out),
// the scan card and the big result banner on the left, today's counters, Export and the latest scans on the right, and a
// Gate records view (dates, type, result, search, files). A scanner in keyboard-wedge mode scans from anywhere on the page.
//
// It talks to the server only through ./client (the gate token, never the HR one). The session is checked on load, every
// 5 minutes and whenever the tab comes back into view (GET me, which also renews the token); when it is over, client.ts
// clears the gate keys and sends the browser to the sign-in with the reason. Sign out ends this session on the server and
// lands on /gatemonitor: never "/" or an HR page.

import { useCallback, useEffect, useRef, useState } from "react";
import { Redirect, useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardList, LogOut, ScanLine } from "lucide-react";
import type { GateMonitorGate, GateScanResult } from "@/lib/api-client/custom-hooks/gate-monitor";
import { useUrlParams } from "@/components/payroll/kit/url-state";
import { UktLogoMark } from "@/components/ui/UktLogoMark";
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
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { ExportButton } from "@/pages/hr/outpass-visitors/kit/ExportButton";
import { istDateKey } from "@/pages/hr/outpass-visitors/kit/fmt";
import {
  GateApiError,
  GateSessionEndedError,
  gateExport,
  gateLogout,
  gateMe,
  gateRecords,
  gateScan,
  gateSummary,
  readGateSession,
  setGateNavigator,
  SIGN_IN_PATH,
} from "./client";
import {
  CARD,
  ConnectionDot,
  LatestScans,
  LiveClock,
  ResultBanner,
  ScanCard,
  ScannerBadge,
  takesLabel,
  TodayCounters,
  VoiceToggle,
} from "./parts";
import { RecordsView } from "./RecordsView";
import { describeScan, OFFLINE_RESULT, type ScanTone } from "./scan-result";
import { makeDuplicateGuard, speak, useScannerConnection, useWedgeScanner } from "./scanner";

/** GET me this often (and on the tab coming back): it keeps the token fresh and notices a sign-out from HR. */
export const HEARTBEAT_MS = 5 * 60_000;
/** Today's counters and the latest scans are read again this often while the tab is visible. */
export const REFRESH_MS = 20_000;
/** How long the scan zone keeps the last answer's colour. */
const FLASH_MS = 1800;
const LATEST_ROWS = 8;
const VIEW_DEFAULTS = { view: "scan" };

const isNetworkError = (e: unknown) => e instanceof GateApiError && e.status === 0;
const retryNetworkOnce = (count: number, e: unknown) => count < 1 && isNetworkError(e);

export default function GateMonitorConsole() {
  if (!readGateSession()) return <Redirect to={SIGN_IN_PATH} replace />;
  return <GateConsole />;
}

function GateConsole() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [{ view }, setView] = useUrlParams(VIEW_DEFAULTS);
  const stored = readGateSession();
  const [gate, setGate] = useState<GateMonitorGate | null>(null);
  const [heartbeatOffline, setHeartbeatOffline] = useState(false);
  const [browserOnline, setBrowserOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  const [result, setResult] = useState<GateScanResult | null>(null);
  const [resultAt, setResultAt] = useState<Date | null>(null);
  const [flash, setFlash] = useState<ScanTone | "idle">("idle");
  const [busy, setBusy] = useState(false);
  const [confirmOut, setConfirmOut] = useState(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Every scan gets the next number; an answer is shown and said only while its scan is still the latest. The scanner
  // does not wait for a slow answer (and a typed code can be followed by a scan), so an older answer arriving last must
  // not replace the newer one on the banner or in the voice.
  const scanSeq = useRef(0);
  const [acceptRead] = useState(() => makeDuplicateGuard());
  const scanner = useScannerConnection();

  // a session that ends while this page is open goes to the sign-in through the router (no reload)
  useEffect(() => {
    setGateNavigator((to) => navigate(to, { replace: true }));
    return () => setGateNavigator(null);
  }, [navigate]);

  // another gate signing in on this browser later must not see this gate's cached rows
  useEffect(() => () => queryClient.removeQueries({ queryKey: ["gate-monitor"] }), [queryClient]);

  // the heartbeat: on load, every 5 minutes, when the tab is shown again, when the network comes back
  useEffect(() => {
    let stopped = false;
    const beat = async () => {
      try {
        const me = await gateMe();
        if (stopped) return;
        setGate(me.gate);
        setHeartbeatOffline(false);
      } catch (e) {
        if (!stopped && isNetworkError(e)) setHeartbeatOffline(true);
      }
    };
    void beat();
    const timer = setInterval(() => void beat(), HEARTBEAT_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void beat();
    };
    const onOnline = () => {
      setBrowserOnline(true);
      void beat();
    };
    const onOffline = () => setBrowserOnline(false);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  const today = istDateKey(new Date());
  const summary = useQuery({
    queryKey: ["gate-monitor", "summary"],
    queryFn: ({ signal }) => gateSummary(signal),
    refetchInterval: REFRESH_MS,
    retry: retryNetworkOnce,
    staleTime: 5_000,
  });
  const latest = useQuery({
    queryKey: ["gate-monitor", "latest", today],
    queryFn: ({ signal }) => gateRecords({ from: today, to: today, page: 1, pageSize: LATEST_ROWS }, signal),
    refetchInterval: REFRESH_MS,
    retry: retryNetworkOnce,
    staleTime: 5_000,
  });

  const online = browserOnline && !heartbeatOffline && !isNetworkError(summary.error) && !isNetworkError(latest.error);

  const refreshLists = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["gate-monitor"] });
  }, [queryClient]);

  const handleScan = useCallback(
    async (raw: string) => {
      if (!acceptRead(raw)) return; // the scanner fired twice for one pass
      if (view === "records") setView({ view: "scan" }); // the answer shows on the scan screen
      const seq = ++scanSeq.current;
      const isLatest = () => seq === scanSeq.current;
      setBusy(true);
      let body: GateScanResult;
      try {
        body = await gateScan(raw);
        if (isLatest()) setHeartbeatOffline(false);
      } catch (e) {
        if (e instanceof GateSessionEndedError) return; // on its way to the sign-in page
        if (isNetworkError(e)) {
          if (isLatest()) setHeartbeatOffline(true);
          body = OFFLINE_RESULT;
        } else {
          body = { result: "error", message: e instanceof Error ? e.message : "The scan could not be checked." };
        }
      } finally {
        if (isLatest()) setBusy(false);
      }
      if (!isLatest()) {
        // a newer scan is on the screen: this answer is not shown or said (it was recorded, so the lists are read again)
        if (body.result !== "offline") refreshLists();
        return;
      }
      const shown = describeScan(body);
      setResult(body);
      setResultAt(new Date());
      setFlash(shown.tone);
      void speak(shown.voice);
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlash("idle"), FLASH_MS);
      if (body.result !== "offline") refreshLists();
    },
    [acceptRead, refreshLists, setView, view],
  );

  useWedgeScanner((raw) => void handleScan(raw));
  useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    },
    [],
  );

  const signOut = async () => {
    setConfirmOut(false);
    await gateLogout();
    queryClient.removeQueries({ queryKey: ["gate-monitor"] });
    navigate(SIGN_IN_PATH, { replace: true });
  };

  const exportToday = async (format: "xlsx" | "pdf") => {
    const filename = await gateExport(format, { from: today, to: today });
    toast({ title: "File downloaded", description: filename });
  };

  const gateName = gate?.name ?? stored?.gateName ?? "Gate";
  const branch = gate?.branchName;
  const takes = gate ? takesLabel(gate.allowOutpass, gate.allowTeaBreak) : "Gate passes and tea breaks";
  const s = summary.data;

  return (
    <div className="flex min-h-screen min-w-0 flex-col bg-slate-50" data-testid="gate-monitor-console">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white">
              <UktLogoMark className="h-7" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                UK Textiles HRMS · Gate Monitor
              </p>
              <h1 className="truncate text-lg font-bold leading-tight text-slate-900" data-testid="gate-name">
                {gateName}
                {branch && <span className="font-medium text-slate-500"> · {branch}</span>}
              </h1>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ConnectionDot online={online} />
            <LiveClock />
            <ScannerBadge status={scanner.status} onPair={() => void scanner.pair()} />
            <VoiceToggle />
            <button
              type="button"
              onClick={() => setConfirmOut(true)}
              className="inline-flex h-11 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
              data-testid="gate-sign-out"
            >
              <LogOut size={15} aria-hidden="true" /> Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full min-w-0 max-w-7xl flex-1 flex-col gap-4 p-4">
        <div
          className="flex w-full overflow-hidden rounded-lg border border-slate-200 bg-white sm:w-auto sm:self-start"
          role="group"
          aria-label="Screen"
        >
          {(
            [
              { value: "scan", label: "Scan", icon: ScanLine },
              { value: "records", label: "Gate records", icon: ClipboardList },
            ] as const
          ).map((v, i) => {
            const on = (view === "records" ? "records" : "scan") === v.value;
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
                data-testid={`view-${v.value}`}
              >
                <Icon size={16} aria-hidden="true" /> {v.label}
              </button>
            );
          })}
        </div>

        {view === "records" ? (
          <RecordsView />
        ) : (
          <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,400px)]">
            <div className="flex min-w-0 flex-col gap-4">
              <ScanCard flash={flash} busy={busy} takes={takes} onSubmitCode={(code) => void handleScan(code)} />
              <ResultBanner
                result={result}
                at={resultAt}
                onDone={() => {
                  setResult(null);
                  setResultAt(null);
                }}
              />
            </div>
            <div className="flex min-w-0 flex-col gap-4">
              <section aria-labelledby="gate-today-title" className={cn(CARD, "p-4")} data-testid="today-card">
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <h2 id="gate-today-title" className="text-base font-bold text-slate-900">
                    Today at this gate
                  </h2>
                  <ExportButton
                    title="Gate records"
                    run={exportToday}
                    label="Export today"
                    hints={{ xlsx: "Today's records of this gate", pdf: "Today's records of this gate" }}
                    testId="today-export"
                    className="ml-auto h-11 sm:h-11"
                  />
                </div>
                <TodayCounters summary={s} loading={summary.isLoading} />
                {s && (
                  <p className="mt-3 text-sm text-slate-600" data-testid="today-out-now">
                    {s.outNow === 0
                      ? "Everyone who went out through this gate today is back."
                      : `Out now: ${s.passesOutNow} on a gate pass, ${s.teaOutNow} on a tea break.`}
                  </p>
                )}
                {!!summary.error && !(summary.error instanceof GateSessionEndedError) && (
                  <p className="mt-3 text-sm text-rose-700">{(summary.error as Error).message}</p>
                )}
              </section>
              <LatestScans
                rows={latest.data?.items}
                loading={latest.isLoading}
                error={
                  latest.error && !(latest.error instanceof GateSessionEndedError)
                    ? (latest.error as Error).message
                    : null
                }
                onSeeAll={() => setView({ view: "records" })}
              />
              <p className="text-center text-xs font-medium uppercase tracking-wide text-slate-500">
                You see only this gate's records.
              </p>
            </div>
          </div>
        )}
      </main>

      <AlertDialog open={confirmOut} onOpenChange={setConfirmOut}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign out of {gateName}?</AlertDialogTitle>
            <AlertDialogDescription>
              Scanning stops on this screen until someone signs in again with the gate's username and password.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Stay signed in</AlertDialogCancel>
            <AlertDialogAction onClick={() => void signOut()} data-testid="gate-sign-out-confirm">
              Sign out
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
