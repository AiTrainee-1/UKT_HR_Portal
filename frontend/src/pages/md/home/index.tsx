import MdLayout from "@/components/md/MdLayout";
import { NoteBanner } from "@/components/md/kit/states";
import { describeMdError, useMdMe, useMdQuery } from "@/lib/api-client/custom-hooks/md";
import { usePublishAssistantContext } from "@/lib/md/assistant-store";
import ExploreSection from "../dashboard/ExploreSection";
import { assistantContext } from "../dashboard/logic";
import type { DashboardOverview } from "../dashboard/types";
import AttendanceOverview from "./AttendanceOverview";
import CommandHeader from "./CommandHeader";
import EmployeeOverview from "./EmployeeOverview";
import type { DashboardHome } from "./home-types";
import { Reveal } from "./motion";
import PayrollOverview from "./PayrollOverview";
import { useWaitingCount } from "./useWaitingCount";

/** The figures are live (people punching in), so the page refreshes itself once a minute while the tab is open. */
const REFRESH_MS = 60_000;

/**
 * The Managing Director's dashboard (redesigned 2026-11-13, owner's brief):
 *
 *   welcome card          kept as it was: the date, the greeting, what wants the MD today and the Ask bar (CommandHeader)
 *   Employee Overview     active employees: total, staff, production, and both per unit
 *   Attendance Overview   today: Present, Absent (the people on approved leave included), CL; everyone / staff /
 *                         production; the last 14 days; today by unit
 *   Monthly Payroll       the current month (still running) against the previous one, and six months side by side
 *   Explore               a tile for every other page
 *
 * The three overviews come from one read-only answer, GET /api/md/dashboard/home (backend md_portal/analytics/home.py).
 * The welcome card's "things to look at" and the assistant's context still come from the overview (dashboard/overview).
 * A part that cannot be read says so in place, with Retry, and the rest stays usable.
 */
export default function MdDashboardHome() {
  const me = useMdMe();
  const overview = useMdQuery<DashboardOverview>("dashboard/overview", undefined, {
    refetchInterval: REFRESH_MS,
    staleTime: 20_000,
  });
  const home = useMdQuery<DashboardHome>("dashboard/home", undefined, {
    refetchInterval: REFRESH_MS,
    staleTime: 20_000,
  });
  const waiting = useWaitingCount();
  usePublishAssistantContext(assistantContext(overview.data));

  const data = home.data;
  const loading = home.isLoading && !data;
  const error = home.isError && !data ? `The figures could not be read: ${describeMdError(home.error)}` : null;
  const retry = () => void home.refetch();

  return (
    <MdLayout>
      <div className="mx-auto max-w-[1600px] space-y-6 @container" data-testid="md-dashboard-page">
        <CommandHeader
          name={me.data?.name}
          serverTime={me.data?.serverTime}
          attention={overview.data?.insightsTotal ?? 0}
          waiting={waiting}
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

        <EmployeeOverview data={data?.employees} loading={loading} error={error} onRetry={retry} />
        <AttendanceOverview data={data?.attendance} loading={loading} error={error} onRetry={retry} />
        <PayrollOverview months={data?.payroll.months} loading={loading} error={error} onRetry={retry} />

        <Reveal index={3}>
          <ExploreSection pages={me.data?.pages} />
        </Reveal>
      </div>
    </MdLayout>
  );
}
