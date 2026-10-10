import type { UseQueryResult } from "@tanstack/react-query";
import AskAiButton from "@/components/md/kit/AskAiButton";
import BarList from "@/components/md/kit/BarList";
import SectionCard from "@/components/md/kit/SectionCard";
import { EmptyBlock } from "@/components/md/kit/states";
import { num } from "@/lib/md/format";
import { bandBars } from "./logic";
import { QueryError, refreshingClass } from "./parts";
import type { GeoReach } from "./types";

/** How far from their unit people punch while on duty: ranked bars by distance band, then the farthest punch and how many
 *  could not be placed because their unit has no location set. Distance is where, not whether it was right. */
export default function ReachCard({ query, ask }: { query: UseQueryResult<GeoReach>; ask: string }) {
  const reach = query.data;
  return (
    <SectionCard
      title="How far from the unit?"
      subtitle="On-duty punches by distance from the unit's location (on-duty work is away from the unit by design)"
      loading={query.isPending}
      provenance={reach?.provenance}
      actions={<AskAiButton question={ask} />}
      bodyClassName={refreshingClass(query)}
      testId="md-geo-reach"
    >
      {query.isError ? (
        <QueryError query={query} />
      ) : reach && reach.punches > 0 ? (
        <>
          <BarList items={bandBars(reach)} testId="md-geo-reach-bars" />
          <p className="md-analytics-note" data-testid="md-geo-reach-line">
            {reach.farthestKm != null ? `Farthest punch: ${num(reach.farthestKm, 1)} km from its unit. ` : ""}
            {num(reach.farPunches)} {reach.farPunches === 1 ? "punch was" : "punches were"} over {num(reach.farKm)} km
            away
            {reach.farPunches > 0 ? ` (${num(reach.farPeople)} ${reach.farPeople === 1 ? "person" : "people"})` : ""}.
          </p>
          {reach.unknownPunches > 0 && (
            <p className="md-analytics-callout md-analytics-tone-watch">
              {num(reach.unknownPunches)} of {num(reach.punches)} punches cannot be placed: their unit has no location
              set (Branches).
            </p>
          )}
        </>
      ) : reach ? (
        <EmptyBlock title="No on-duty punches in this period" testId="md-geo-reach-empty">
          Nobody took an on-duty punch for this selection, so there is no distance to show.
        </EmptyBlock>
      ) : null}
    </SectionCard>
  );
}
