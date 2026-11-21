import type { UseQueryResult } from "@tanstack/react-query";
import AskAiButton from "@/components/md/kit/AskAiButton";
import BarList from "@/components/md/kit/BarList";
import SectionCard from "@/components/md/kit/SectionCard";
import { CHART } from "@/components/md/kit/chartTheme";
import { EmptyBlock } from "@/components/md/kit/states";
import { num } from "@/lib/md/format";
import { cn } from "@/lib/utils";
import { QueryError, refreshingClass } from "./cards";
import { hoursText } from "./logic";
import type { Band, Drill, RqWaiting } from "./types";

const BAND_TONE: Record<Band, string> = {
  under_1d: "md-analytics-tone-good",
  "1_3d": "md-analytics-tone-info",
  "3_7d": "md-analytics-tone-watch",
  over_7d: "md-analytics-tone-bad",
};

const HOLDER_COLOR = { hr: CHART.brand, hod: CHART.leave, either: CHART.info } as const;

/** What is waiting right now (whatever date it was made): how long, with whom, and of which kind. Every figure opens the
 *  requests behind it. A snapshot: the period does not hide a request that has waited for weeks. */
export default function WaitingCard({
  query,
  ask,
  onDrill,
}: {
  query: UseQueryResult<RqWaiting>;
  ask: string;
  onDrill: (d: Drill) => void;
}) {
  const data = query.data;
  return (
    <SectionCard
      title="Waiting now"
      subtitle="How long requests have waited and who they wait on: a snapshot, whatever the period"
      loading={query.isPending}
      provenance={data?.provenance}
      actions={<AskAiButton question={ask} />}
      bodyClassName={refreshingClass(query)}
      testId="md-requests-waiting"
    >
      {query.isError ? (
        <QueryError query={query} />
      ) : data && data.total > 0 ? (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-2 @2xl:grid-cols-4" data-testid="md-requests-bands">
            {data.buckets.map((b) => (
              <button
                key={b.key}
                type="button"
                onClick={() =>
                  onDrill({ title: `Waiting ${b.label.toLowerCase()}`, params: { status: "waiting", band: b.key } })
                }
                className={cn("md-analytics-stat text-left", BAND_TONE[b.key])}
                data-testid={`md-requests-band-${b.key}`}
              >
                <p className="md-analytics-stat-value">{num(b.count)}</p>
                <p className="md-analytics-stat-label">{b.label}</p>
              </button>
            ))}
          </div>
          <div>
            <h4 className="md-analytics-subhead">Who they wait on</h4>
            <BarList
              testId="md-requests-holders"
              items={data.byHolder
                .filter((h) => h.total > 0)
                .map((h) => ({
                  key: h.key,
                  label: h.label,
                  value: h.total,
                  color: HOLDER_COLOR[h.key],
                  sub: `${num(h.threeDaysPlus)} waited 3+ days · oldest ${hoursText(h.oldestHours)}`,
                }))}
              format={(n) => num(n)}
              onSelect={(item) =>
                onDrill({
                  title: `Waiting on ${item.key === "hod" ? "a Department Head" : String(item.label)}`,
                  params: { status: "waiting", holder: item.key },
                })
              }
            />
          </div>
          <div>
            <h4 className="md-analytics-subhead">By kind</h4>
            <BarList
              testId="md-requests-waiting-kinds"
              items={data.byKind.slice(0, 8).map((k) => ({
                key: k.key,
                label: k.label,
                value: k.total,
                sub:
                  k.threeDaysPlus > 0
                    ? `${num(k.threeDaysPlus)} waited 3+ days · oldest ${hoursText(k.oldestHours)}`
                    : `oldest ${hoursText(k.oldestHours)}`,
              }))}
              format={(n) => num(n)}
              onSelect={(item) =>
                onDrill({ title: `${String(item.label)} waiting`, params: { status: "waiting", kind: item.key } })
              }
            />
          </div>
        </div>
      ) : data ? (
        <EmptyBlock title="Nothing is waiting" testId="md-requests-waiting-empty">
          Every request for this selection has been decided.
        </EmptyBlock>
      ) : null}
    </SectionCard>
  );
}
