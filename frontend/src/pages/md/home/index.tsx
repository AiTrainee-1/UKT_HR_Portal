import { useCallback, useState } from "react";
import MdLayout from "@/components/md/MdLayout";
// the page the MD lands on: its shell (and the MD skin) download together with it, not after it
import "@/components/md/MdShell";
import { NoteBanner } from "@/components/md/kit/states";
import { describeMdError, useMdMe, useMdQuery } from "@/lib/api-client/custom-hooks/md";
import { usePublishAssistantContext } from "@/lib/md/assistant-store";
import ExploreSection from "../dashboard/ExploreSection";
import { assistantContext } from "../dashboard/logic";
import type { DashboardOverview } from "../dashboard/types";
import AttendanceOverview from "./AttendanceOverview";
import CommandHeader from "./CommandHeader";
import EmployeeOverview from "./EmployeeOverview";
import { monthOf, validMonth } from "./home-logic";
import type { DashboardHome } from "./home-types";
import KpiBand from "./KpiBand";
import MonthBar from "./MonthBar";
import { Reveal } from "./motion";
import PayrollOverview from "./PayrollOverview";

/** The running month's figures are live (people punching in), so they refresh once a minute while the tab is open. */
const REFRESH_MS = 60_000;
/** The company-wide exceptions (the welcome card's "things to look at") change slowly and cost the server the most. */
const OVERVIEW_REFRESH_MS = 5 * 60_000;

/** ?month=YYYY-MM in the address (the running month when absent), so a refresh or a shared link keeps the month. The
 *  address is updated in place (no history entry per step of the arrows). */
function useMonthParam(running: string | null): [string | null, (next: string | null) => void] {
  const [raw, setRaw] = useState<string | null>(() =>
    typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("month"),
  );
  const set = useCallback((next: string | null) => {
    setRaw(next);
    try {
      const url = new URL(window.location.href);
      if (next) url.searchParams.set("month", next);
      else url.searchParams.delete("month");
      window.history.replaceState(window.history.state, "", url);
    } catch {
      // no address to keep it in (a test, an old browser): the month still changes on the page
    }
  }, []);
  // until the server's clock is known, any well-formed month is taken as asked; an impossible one means the running month
  const month = running ? validMonth(raw, running) : raw && /^\d{4}-(0[1-9]|1[0-2])$/.test(raw) ? raw : null;
  return [month === running ? null : month, set];
}

/**
 * The Managing Director's dashboard (redesigned 2026-11-13, owner's brief; performance round 2026-11-21):
 *
 *   welcome card          kept as it was: the date, the greeting, what wants the MD today and the Ask bar (CommandHeader)
 *   month                 the month the attendance and payroll figures are for (MonthBar; ?month= in the address)
 *   four figures          employees, attendance, the month's pay, requests waiting: each opens its page (KpiBand)
 *   Employee Overview     active employees: total, staff, production, and both per unit
 *   Attendance Overview   today (or the chosen month): Present, Absent (the people on approved leave included), CL;
 *                         everyone / staff / production; the month day by day; by unit
 *   Monthly Payroll       the chosen month (running by default) against the one before, and six months side by side
 *   Explore               a tile for every other page
 *
 * Fast on purpose: everything under the welcome card comes from ONE read-only answer, GET /api/md/dashboard/home
 * (backend md_portal/analytics/home.py, the requests waiting included), its charts are light SVG / CSS (kit/LiteCharts,
 * no chart library), its motion is CSS, and the slow company-wide overview (the welcome card's "things to look at" and
 * the assistant's context) is asked for only once the figures are in. A part that cannot be read says so in place, with
 * Retry, and the rest stays usable.
 */
export default function MdDashboardHome() {
  const me = useMdMe();
  const running = monthOf(me.data?.serverTime);
  const [month, setMonth] = useMonthParam(running);
  const home = useMdQuery<DashboardHome>("dashboard/home", month ? { month } : undefined, {
    refetchInterval: month ? false : REFRESH_MS,
    staleTime: month ? 5 * 60_000 : 20_000,
  });
  // the heavy one waits for the figures, so it never queues in front of them on the server
  const overview = useMdQuery<DashboardOverview>("dashboard/overview", undefined, {
    enabled: !!home.data || home.isError,
    refetchInterval: OVERVIEW_REFRESH_MS,
    staleTime: 2 * 60_000,
  });
  usePublishAssistantContext(assistantContext(overview.data));

  const data = home.data;
  const runningMonth = running ?? monthOf(data?.today);
  const loading = home.isLoading && !data;
  const error = home.isError && !data ? `The figures could not be read: ${describeMdError(home.error)}` : null;
  const retry = () => void home.refetch();

  return (
    <MdLayout>
      <div className="mx-auto max-w-[1600px] space-y-6 @container" data-testid="md-dashboard-page">
        <CommandHeader
          name={me.data?.name}
          serverTime={me.data?.serverTime}
          attention={overview.data?.insightsTotal ?? null}
          waiting={data?.waiting?.total ?? 0}
        />

        {data?.notes && data.notes.length > 0 && (
          <NoteBanner>
            {data.notes.map((n) => (
              <span key={n} className="block">
                {n}
              </span>
            ))}
          </NoteBanner>
        )}

        <Reveal index={0} testId="md-home-summary" className="space-y-4">
          {runningMonth ? (
            <MonthBar month={month} running={runningMonth} onChange={setMonth} />
          ) : (
            <div className="h-9" aria-hidden />
          )}
          {!error && <KpiBand data={data} month={month} />}
        </Reveal>

        <EmployeeOverview data={data?.employees} loading={loading} error={error} onRetry={retry} />
        <AttendanceOverview data={data?.attendance} loading={loading} error={error} onRetry={retry} />
        <PayrollOverview months={data?.payroll.months} month={month} loading={loading} error={error} onRetry={retry} />

        <Reveal index={4} className="md-dashboard-defer">
          <ExploreSection pages={me.data?.pages} />
        </Reveal>
      </div>
    </MdLayout>
  );
}
