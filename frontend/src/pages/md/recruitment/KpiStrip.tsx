import { Briefcase, CalendarClock, FileClock, Hourglass, TrendingDown, UserMinus, UserPlus, Users } from "lucide-react";
import StatCard from "@/components/md/kit/StatCard";
import { num, pct } from "@/lib/md/format";
import { daysText, deltaOf, plural, waitTone } from "./logic";
import { Chip } from "./parts";
import type { QueryLike, RecruitmentSummary } from "./types";

/** The headline strip: where hiring stands today, what happened in the period, and each change against the period
 *  before. Every card says how its figure is worked out. */
export default function KpiStrip({ query }: { query: QueryLike<RecruitmentSummary> }) {
  const data = query.data;
  const c = data?.current;
  const changes = data?.changes;
  const provenance = data?.provenance;
  const loading = query.isPending;
  const warnAfter = data?.thresholds.resignationWarnAfterDays ?? 7;
  const waitingTone = c?.oldestPendingDays == null ? "slate" : waitTone(c.oldestPendingDays, warnAfter);

  return (
    <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4 @3xl:gap-4" data-testid="md-recruitment-kpis">
      <StatCard
        testId="md-recruitment-kpi-open"
        label="Open positions"
        value={c ? num(c.openPositions) : "—"}
        sub={
          c
            ? c.vacancies == null
              ? "No staffing plan set"
              : `${plural(c.vacancies, "vacancy", "vacancies")} against plan`
            : undefined
        }
        icon={Briefcase}
        tone="blue"
        loading={loading}
        provenance={provenance}
        provenanceIds={["open-positions", "vacancies"]}
      >
        {c && c.stalePositions > 0 && <Chip tone="amber">{c.stalePositions} open too long</Chip>}
      </StatCard>

      <StatCard
        testId="md-recruitment-kpi-age"
        label="Average days open"
        value={c?.avgOpenDays == null ? "—" : daysText(Math.round(c.avgOpenDays))}
        sub={c ? (c.oldestOpenDays == null ? "No open positions" : `Oldest ${daysText(c.oldestOpenDays)}`) : undefined}
        icon={Hourglass}
        tone={c && c.stalePositions > 0 ? "amber" : "slate"}
        loading={loading}
        provenance={provenance}
        provenanceIds={["position-age", "time-to-fill"]}
      />

      <StatCard
        testId="md-recruitment-kpi-pipeline"
        label="Candidates in the pipeline"
        value={c ? num(c.applicantsInPipeline) : "—"}
        sub={c ? `${num(c.pipelineJobBoard)} job board · ${num(c.pipelineScreening)} resumes` : undefined}
        icon={Users}
        tone="indigo"
        loading={loading}
        provenance={provenance}
        provenanceIds={["pipeline"]}
      />

      <StatCard
        testId="md-recruitment-kpi-interviews"
        label="Interviews, next 7 days"
        value={c ? num(c.interviewsNext7Days) : "—"}
        sub={
          c
            ? `${num(c.interviewsHeld)} held in the period${c.interviewsToday ? ` · ${num(c.interviewsToday)} today` : ""}`
            : undefined
        }
        icon={CalendarClock}
        tone="purple"
        loading={loading}
        provenance={provenance}
        provenanceIds={["interviews"]}
      />

      <StatCard
        testId="md-recruitment-kpi-joined"
        label="Joined"
        value={c ? num(c.joiners) : "—"}
        sub={c ? `${num(c.joinersStaff)} staff · ${num(c.joinersProduction)} production` : undefined}
        icon={UserPlus}
        tone="green"
        delta={deltaOf(changes?.joiners, "number", "up")}
        loading={loading}
        provenance={provenance}
        provenanceIds={["joiners"]}
      />

      <StatCard
        testId="md-recruitment-kpi-left"
        label="Left"
        value={c ? num(c.leavers) : "—"}
        sub={c ? `${num(c.leaversResigned)} resigned · ${num(c.leaversDeactivated)} other exits` : undefined}
        icon={UserMinus}
        tone="indigo"
        delta={deltaOf(changes?.leavers, "number", "down")}
        loading={loading}
        provenance={provenance}
        provenanceIds={["leavers"]}
      />

      <StatCard
        testId="md-recruitment-kpi-pending"
        label="Resignations awaiting a decision"
        value={c ? num(c.resignationsPending) : "—"}
        sub={
          c
            ? c.oldestPendingDays == null
              ? "None waiting"
              : `Oldest waiting ${daysText(c.oldestPendingDays)}`
            : undefined
        }
        icon={FileClock}
        tone={waitingTone}
        loading={loading}
        provenance={provenance}
        provenanceIds={["resignations-pending"]}
      >
        {c && c.onNotice > 0 && <Chip tone="slate">{c.onNotice} serving notice</Chip>}
      </StatCard>

      <StatCard
        testId="md-recruitment-kpi-attrition"
        label="Attrition"
        value={c ? pct(c.attritionPct) : "—"}
        sub={
          c
            ? c.attritionPct == null
              ? "No headcount to measure against"
              : c.attritionAnnualisedPct == null
                ? "Too short a period for a yearly rate"
                : `About ${pct(c.attritionAnnualisedPct, 0)} a year`
            : undefined
        }
        icon={TrendingDown}
        tone="purple"
        delta={deltaOf(changes?.attritionPct, "pct", "down")}
        loading={loading}
        provenance={provenance}
        provenanceIds={["attrition"]}
      />
    </div>
  );
}
