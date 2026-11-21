import { Activity, X } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import { FilterBar, PeriodBar } from "@/components/md/kit/FilterBar";
import MdPageHeader from "@/components/md/kit/MdPageHeader";
import { MonthPicker, monthLabel, monthRange, thisMonthKey } from "@/components/md/kit/MonthPicker";
import { ErrorBanner, NoteBanner } from "@/components/md/kit/states";
import MdLayout from "@/components/md/MdLayout";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { describeMdError, useMdQuery } from "@/lib/api-client/custom-hooks/md";
import { usePublishAssistantContext } from "@/lib/md/assistant-store";
import { num } from "@/lib/md/format";
import type { PeriodChoice } from "@/lib/md/period";
import {
  monthFromParams,
  monthPatch,
  periodFromParams,
  periodKey,
  periodPatch,
  periodQuery,
  useUrlParams,
} from "@/lib/md/url-filters";
import AreasCard from "./activity/AreasCard";
import AttentionCard from "./activity/AttentionCard";
import HeatmapCard from "./activity/HeatmapCard";
import KpiStrip from "./activity/KpiStrip";
import { ask, assistantSummary, periodLabel } from "./activity/logic";
import { scrollToCard } from "./activity/parts";
import SensitiveCard from "./activity/SensitiveCard";
import SignInsCard from "./activity/SignInsCard";
import TrendCard from "./activity/TrendCard";
import type { ActivityOptions, ActivitySummary } from "./activity/types";
import UsersCard from "./activity/UsersCard";

const DEFAULT_PERIOD: PeriodChoice = { preset: "last_30_days" };
const ALL = "__all__";

/**
 * Activity Logs: what people are doing in the system and whether anything sensitive or unusual is happening. An audit
 * entry belongs to an HR account, not to a unit or department, so there is no scope bar; instead the page narrows to one
 * area of the system and / or one person (2026-11-21), and every card follows (sign-ins follow the person only). The
 * period, a month, the area and the person live in the address. Exceptions come first ("Needs your attention", always
 * the last 7 days), then the headline figures, the trend, where the activity is and who does it, when, the actions
 * themselves (each opens in full) and the sign-ins.
 */
export default function MdActivity() {
  const [params, update] = useUrlParams();
  const month = monthFromParams(params);
  const period = periodFromParams(params, DEFAULT_PERIOD);
  const area = params.get("area") || null;
  const actor = params.get("actor") || null;
  const periodOnly = periodQuery(period, month);
  const query: Record<string, string> = {
    ...periodOnly,
    ...(area ? { area } : {}),
    ...(actor ? { actor } : {}),
  };

  const summary = useMdQuery<ActivitySummary>("activity/summary", query);
  const options = useMdQuery<ActivityOptions>("activity/options", periodOnly);
  const label = summary.data?.period?.label ?? (month ? monthLabel(month) : periodLabel(period));
  const areaName = area ? (options.data?.areas.find((a) => a.area === area)?.label ?? area) : null;

  usePublishAssistantContext({
    page: "activity",
    title: "Activity Logs",
    filters: {
      Period: label,
      ...(areaName ? { Area: areaName } : {}),
      ...(actor ? { Person: actor } : {}),
    },
    summary: assistantSummary(summary.data),
  });

  const setArea = (next: string | null) => update({ area: next });
  const setActor = (next: string | null) => update({ actor: next });
  const pickPerson = (name: string) => {
    setActor(name === actor ? null : name);
    scrollToCard("md-activity-sensitive");
  };
  // the chosen area / person stays in the lists even when the period has none of its actions
  const areaOptions = options.data?.areas ?? [];
  const peopleOptions = options.data?.people ?? [];
  const trigger = "md-field h-9 w-full text-xs font-semibold sm:w-[12.5rem]";

  return (
    <MdLayout>
      <div className="mx-auto max-w-[1500px] space-y-4 @lg:space-y-5" data-testid="md-activity-page">
        <MdPageHeader
          icon={Activity}
          title="Activity Logs"
          subtitle="What people are doing in the system, and whether anything sensitive or unusual is happening."
          updatedAt={summary.data?.generatedAt}
          actions={<AskAiButton question={ask.page(label)} label="Ask about this page" size="md" />}
        />
        <FilterBar>
          <div className="min-w-0 max-w-full overflow-x-auto">
            <PeriodBar
              key={periodKey(period, month)}
              value={month ? { preset: "custom", ...monthRange(month) } : period}
              onChange={(next) => update(periodPatch(next))}
            />
          </div>
          <MonthPicker value={month ?? thisMonthKey()} onChange={(m) => update(monthPatch(m))} label="Month" />
          <div
            className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:items-center"
            data-testid="md-activity-focus"
          >
            <Select value={area ?? ALL} onValueChange={(v) => setArea(v === ALL ? null : v)}>
              <SelectTrigger className={trigger} aria-label="Area of the system" data-testid="md-activity-area">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All areas</SelectItem>
                {area && !areaOptions.some((a) => a.area === area) && <SelectItem value={area}>{areaName}</SelectItem>}
                {areaOptions.map((a) => (
                  <SelectItem key={a.area} value={a.area}>
                    {a.label} ({num(a.actions)})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={actor ?? ALL} onValueChange={(v) => setActor(v === ALL ? null : v)}>
              <SelectTrigger className={trigger} aria-label="Person" data-testid="md-activity-actor">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Everyone</SelectItem>
                {actor && !peopleOptions.some((p) => p.userName === actor) && (
                  <SelectItem value={actor}>{actor}</SelectItem>
                )}
                {peopleOptions.map((p) => (
                  <SelectItem key={p.userName} value={p.userName}>
                    {p.userName} · {p.kind} ({num(p.actions)})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {(area || actor) && (
            <button
              type="button"
              onClick={() => update({ area: null, actor: null })}
              className="md-btn md-btn-ghost md-btn-sm"
              data-testid="md-activity-clear-focus"
            >
              <X size={13} aria-hidden="true" /> Clear area and person
            </button>
          )}
        </FilterBar>

        {summary.isError && <ErrorBanner message={describeMdError(summary.error)} onRetry={() => summary.refetch()} />}
        {summary.data?.notes.map((note) => (
          <NoteBanner key={note}>{note}</NoteBanner>
        ))}

        <KpiStrip params={query} />
        <AttentionCard />
        <TrendCard params={query} label={label} />

        <div className="grid grid-cols-1 items-start gap-4 @lg:gap-5 @4xl:grid-cols-12">
          <AreasCard
            params={query}
            label={label}
            className="@4xl:col-span-5"
            activeArea={area}
            onSelectArea={setArea}
          />
          <UsersCard params={query} label={label} onSelectUser={pickPerson} className="@4xl:col-span-7" />
        </div>

        <div id="md-activity-heatmap">
          <HeatmapCard params={query} label={label} />
        </div>
        <div id="md-activity-sensitive">
          <SensitiveCard base={query} label={label} user={actor} onUserChange={setActor} />
        </div>
        <div id="md-activity-sign-ins">
          <SignInsCard params={query} label={label} />
        </div>
      </div>
    </MdLayout>
  );
}
