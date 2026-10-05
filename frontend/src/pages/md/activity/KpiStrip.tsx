import { Activity, LogIn, Moon, ShieldAlert, ShieldX, Users } from "lucide-react";
import StatCard from "@/components/md/kit/StatCard";
import { useMdQuery, type MdQueryParams } from "@/lib/api-client/custom-hooks/md";
import { num } from "@/lib/md/format";
import {
  afterHoursSub,
  alertTone,
  deltaOf,
  failedSub,
  peopleSub,
  previousText,
  severitySub,
  signInsSub,
  sparkOf,
} from "./logic";
import { scrollToCard } from "./parts";
import type { ActivitySummary, ActivityTrend } from "./types";

const dash = "—";

/** The six headline figures, each against the previous period of the same length, with a sparkline from the trend. */
export default function KpiStrip({ params }: { params: MdQueryParams }) {
  const summary = useMdQuery<ActivitySummary>("activity/summary", params);
  const trend = useMdQuery<ActivityTrend>("activity/trend", params);
  const s = summary.data;
  const t = trend.data;
  const loading = summary.isPending;
  const before = s?.previousPeriod.label ?? "Previous period";

  return (
    <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-3 @6xl:grid-cols-6" data-testid="md-activity-kpis">
      <StatCard
        label="Actions"
        icon={Activity}
        tone="blue"
        loading={loading}
        value={s ? num(s.actions.value) : dash}
        sub={s ? previousText(before, s.actions.previous) : undefined}
        delta={s ? deltaOf(s.actions.change, null) : null}
        spark={sparkOf(t, "actions")}
        provenance={s?.provenance}
        provenanceIds={["actions"]}
        testId="md-activity-kpi-actions"
      />
      <StatCard
        label="Active people"
        icon={Users}
        tone="teal"
        loading={loading}
        value={s ? num(s.activeUsers.value) : dash}
        sub={s ? peopleSub(s.activeUsers.enabledAccounts) : undefined}
        delta={s ? deltaOf(s.activeUsers.change, null) : null}
        spark={sparkOf(t, "activeUsers")}
        provenance={s?.provenance}
        provenanceIds={["active-users"]}
        testId="md-activity-kpi-people"
      />
      <StatCard
        label="Sensitive actions"
        icon={ShieldAlert}
        tone={s ? alertTone(s.sensitive.critical, s.sensitive.value) : "slate"}
        loading={loading}
        value={s ? num(s.sensitive.value) : dash}
        sub={s ? severitySub(s.sensitive) : undefined}
        delta={s ? deltaOf(s.sensitive.change, "down") : null}
        spark={sparkOf(t, "sensitive")}
        provenance={s?.provenance}
        provenanceIds={["sensitive"]}
        onClick={() => scrollToCard("md-activity-sensitive")}
        testId="md-activity-kpi-sensitive"
      />
      <StatCard
        label="After-hours actions"
        icon={Moon}
        tone="indigo"
        loading={loading}
        value={s ? num(s.afterHours.value) : dash}
        sub={s ? afterHoursSub(s.afterHours) : undefined}
        delta={s ? deltaOf(s.afterHours.change, "down") : null}
        spark={sparkOf(t, "afterHours")}
        provenance={s?.provenance}
        provenanceIds={["after-hours"]}
        onClick={() => scrollToCard("md-activity-heatmap")}
        testId="md-activity-kpi-after-hours"
      />
      <StatCard
        label="Sign-ins"
        icon={LogIn}
        tone="purple"
        loading={loading}
        value={s ? num(s.signIns.value) : dash}
        sub={s ? signInsSub(s.signIns.people) : undefined}
        delta={s ? deltaOf(s.signIns.change, null) : null}
        spark={sparkOf(t, "signIns")}
        provenance={s?.provenance}
        provenanceIds={["sign-ins"]}
        onClick={() => scrollToCard("md-activity-sign-ins")}
        testId="md-activity-kpi-sign-ins"
      />
      <StatCard
        label="Failed sign-ins"
        icon={ShieldX}
        tone={s ? alertTone(s.failedSignIns.lockouts, s.failedSignIns.value) : "slate"}
        loading={loading}
        value={s ? num(s.failedSignIns.value) : dash}
        sub={s ? failedSub(s.failedSignIns) : undefined}
        delta={s ? deltaOf(s.failedSignIns.change, "down") : null}
        spark={sparkOf(t, "failedSignIns")}
        provenance={s?.provenance}
        provenanceIds={["failed-sign-ins"]}
        onClick={() => scrollToCard("md-activity-sign-ins")}
        testId="md-activity-kpi-failed"
      />
    </div>
  );
}
