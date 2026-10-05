import { useState } from "react";
import { Coffee } from "lucide-react";
import MdLayout from "@/components/md/MdLayout";
import AskAiButton from "@/components/md/kit/AskAiButton";
import { FilterBar, PeriodBar, ScopeBar } from "@/components/md/kit/FilterBar";
import MdPageHeader from "@/components/md/kit/MdPageHeader";
import { ErrorBanner } from "@/components/md/kit/states";
import { PillTabs } from "@/components/ui/pill-tabs";
import { describeMdError, useMdOrg } from "@/lib/api-client/custom-hooks/md";
import { usePublishAssistantContext } from "@/lib/md/assistant-store";
import {
  EVERYONE,
  periodParams,
  scopeIsEveryone,
  scopeParams,
  type PeriodChoice,
  type ScopeChoice,
} from "@/lib/md/period";
import AttentionCard from "./tea-break/AttentionCard";
import BreakdownCard from "./tea-break/BreakdownCard";
import CoverageNote from "./tea-break/CoverageNote";
import HeatmapCard from "./tea-break/HeatmapCard";
import KpiStrip from "./tea-break/KpiStrip";
import OffendersCard from "./tea-break/OffendersCard";
import RuleCard from "./tea-break/RuleCard";
import TrendCard from "./tea-break/TrendCard";
import { useTeaBreakData } from "./tea-break/hooks";
import { GROUP_TABS, askQuestions, assistantSummary, focusScope, periodText, scopeText } from "./tea-break/logic";
import type { GroupBy, TeaGroupRow } from "./tea-break/types";

/** Tea Break: is break discipline costing production time? Overruns, minutes lost, where and when it happens, and
 *  whether it is getting better or worse. */
export default function MdTeaBreak() {
  const [period, setPeriod] = useState<PeriodChoice>({ preset: "last_30_days" });
  const [scope, setScope] = useState<ScopeChoice>(EVERYONE);
  const [by, setBy] = useState<GroupBy>("department");
  const org = useMdOrg();
  const data = useTeaBreakData({ ...periodParams(period), ...scopeParams(scope) }, by);
  const { summary } = data;

  const periodLabel = summary.data?.period?.label ?? periodText(period);
  const selection = scopeText(scope, summary.data?.scope?.description);
  const ask = askQuestions(periodLabel, scopeIsEveryone(scope) ? null : selection);

  usePublishAssistantContext({
    page: "tea-break",
    title: "Tea Break",
    filters: { Period: periodLabel, Scope: selection },
    summary: assistantSummary(summary.data),
  });

  const focus = (kind: GroupBy) => (row: TeaGroupRow) => {
    const next = focusScope(scope, kind, row, org.data);
    if (next) setScope(next);
  };

  return (
    <MdLayout>
      <div className="mx-auto max-w-[1500px] space-y-5" data-testid="md-tea-break">
        <MdPageHeader
          icon={Coffee}
          title="Tea Break"
          subtitle="Is break discipline costing production time? Overruns, minutes lost, where and when it happens."
          updatedAt={summary.data?.generatedAt}
          actions={<AskAiButton question={ask.page} label="Ask AI about this page" size="md" />}
        />

        <FilterBar>
          <PeriodBar value={period} onChange={setPeriod} />
          <ScopeBar value={scope} onChange={setScope} org={org.data} />
        </FilterBar>

        {summary.isError && (
          <ErrorBanner message={describeMdError(summary.error)} onRetry={() => void summary.refetch()} />
        )}

        <KpiStrip summary={summary} trend={data.trend} offenders={data.offenders} />

        <AttentionCard query={data.attention} ask={ask.attention} />

        <TrendCard query={data.trend} ask={ask.trend} />

        <div className="grid grid-cols-1 items-start gap-5 @4xl:grid-cols-2">
          <BreakdownCard
            title="Where it happens"
            subtitle="Ranked by minutes lost, against the previous period"
            query={data.groups}
            ask={ask.departments}
            testId="md-tea-break-groups"
            nameHeader={GROUP_TABS.find((t) => t.value === by)?.header ?? "Group"}
            tabs={
              <div data-testid="md-tea-break-group-tabs">
                <PillTabs
                  size="sm"
                  items={GROUP_TABS.map((t) => ({ value: t.value, label: t.label }))}
                  value={by}
                  onChange={(v) => setBy(v as GroupBy)}
                />
              </div>
            }
            onFocus={focus(by)}
            emptyText="No departments, units or groups to compare for this selection."
          />
          <BreakdownCard
            title="Shift comparison"
            subtitle="A break counts under the shift the person was on that day"
            query={data.shifts}
            ask={ask.shifts}
            testId="md-tea-break-shifts"
            nameHeader="Shift"
            emptyText="No shifts to compare for this selection."
          />
        </div>

        <HeatmapCard query={data.heatmap} ask={ask.heatmap} />

        <OffendersCard query={data.offenders} ask={ask.offenders} />

        <RuleCard query={data.rule} ask={ask.rule} />

        <CoverageNote notes={summary.data?.notes} />
      </div>
    </MdLayout>
  );
}
