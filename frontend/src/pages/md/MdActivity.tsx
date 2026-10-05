import { useState } from "react";
import { Activity } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import { FilterBar, PeriodBar } from "@/components/md/kit/FilterBar";
import MdPageHeader from "@/components/md/kit/MdPageHeader";
import { ErrorBanner, NoteBanner } from "@/components/md/kit/states";
import MdLayout from "@/components/md/MdLayout";
import { describeMdError, useMdQuery } from "@/lib/api-client/custom-hooks/md";
import { usePublishAssistantContext } from "@/lib/md/assistant-store";
import { periodParams, type PeriodChoice } from "@/lib/md/period";
import AreasCard from "./activity/AreasCard";
import AttentionCard from "./activity/AttentionCard";
import HeatmapCard from "./activity/HeatmapCard";
import KpiStrip from "./activity/KpiStrip";
import { ask, assistantSummary, periodLabel } from "./activity/logic";
import { scrollToCard } from "./activity/parts";
import SensitiveCard from "./activity/SensitiveCard";
import SignInsCard from "./activity/SignInsCard";
import TrendCard from "./activity/TrendCard";
import type { ActivitySummary } from "./activity/types";
import UsersCard from "./activity/UsersCard";

/**
 * Activity Logs: what people are doing in the system and whether anything sensitive or unusual is happening. Only the
 * period applies (an audit entry belongs to an HR user, not to a unit or department), so there is no scope bar.
 * Exceptions come first ("Needs your attention"), then the trend, where the activity is and who does it, when, the
 * sensitive actions themselves, and the sign-ins. Every card explains its numbers and has an "Ask AI".
 */
export default function MdActivity() {
  const [period, setPeriod] = useState<PeriodChoice>({ preset: "last_30_days" });
  const [person, setPerson] = useState<string | null>(null);
  const params = periodParams(period);
  const summary = useMdQuery<ActivitySummary>("activity/summary", params);
  const label = summary.data?.period?.label ?? periodLabel(period);

  usePublishAssistantContext({
    page: "activity",
    title: "Activity Logs",
    filters: { Period: label },
    summary: assistantSummary(summary.data),
  });

  const pickPerson = (name: string) => {
    setPerson(name);
    scrollToCard("md-activity-sensitive");
  };

  return (
    <MdLayout>
      <div className="mx-auto max-w-[1500px] space-y-5" data-testid="md-activity-page">
        <MdPageHeader
          icon={Activity}
          title="Activity Logs"
          subtitle="What people are doing in the system, and whether anything sensitive or unusual is happening."
          updatedAt={summary.data?.generatedAt}
          actions={<AskAiButton question={ask.page(label)} label="Ask about this page" size="md" />}
        />
        <FilterBar>
          <PeriodBar value={period} onChange={setPeriod} />
        </FilterBar>

        {summary.isError && <ErrorBanner message={describeMdError(summary.error)} onRetry={() => summary.refetch()} />}
        {summary.data?.notes.map((note) => (
          <NoteBanner key={note}>{note}</NoteBanner>
        ))}

        <KpiStrip params={params} />
        <AttentionCard />
        <TrendCard params={params} label={label} />

        <div className="grid grid-cols-1 items-start gap-5 @4xl:grid-cols-12">
          <AreasCard params={params} label={label} className="@4xl:col-span-5" />
          <UsersCard params={params} label={label} onSelectUser={pickPerson} className="@4xl:col-span-7" />
        </div>

        <div id="md-activity-heatmap">
          <HeatmapCard params={params} label={label} />
        </div>
        <div id="md-activity-sensitive">
          <SensitiveCard period={period} label={label} user={person} onUserChange={setPerson} />
        </div>
        <div id="md-activity-sign-ins">
          <SignInsCard params={params} label={label} />
        </div>
      </div>
    </MdLayout>
  );
}
