import { useState } from "react";
import { Boxes } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import BarList from "@/components/md/kit/BarList";
import SectionCard from "@/components/md/kit/SectionCard";
import { EmptyBlock, ErrorBanner } from "@/components/md/kit/states";
import { Button } from "@/components/ui/button";
import { describeMdError, useMdQuery, type MdQueryParams } from "@/lib/api-client/custom-hooks/md";
import { num } from "@/lib/md/format";
import { AREAS_SHOWN, areaBars, ask } from "./logic";
import type { ActivityAreas } from "./types";

/** Where the activity is: actions by area of the system, with their share and the change on the period before. */
export default function AreasCard({
  params,
  label,
  className,
}: {
  params: MdQueryParams;
  label: string;
  className?: string;
}) {
  const q = useMdQuery<ActivityAreas>("activity/modules", params);
  const [showAll, setShowAll] = useState(false);
  const a = q.data;
  return (
    <SectionCard
      title="Where the activity is"
      subtitle="Actions by area of the system"
      provenance={a?.provenance}
      loading={q.isPending}
      actions={<AskAiButton question={ask.areas(label)} />}
      className={className}
      testId="md-activity-areas"
    >
      {q.isError ? (
        <ErrorBanner message={describeMdError(q.error)} onRetry={() => q.refetch()} />
      ) : a && a.areas.length === 0 ? (
        <EmptyBlock icon={Boxes} title="No activity to break down" testId="md-activity-areas-empty">
          No actions were recorded in this period.
        </EmptyBlock>
      ) : a ? (
        <>
          <BarList items={areaBars(a.areas, showAll)} testId="md-activity-area-bars" />
          {a.areas.length > AREAS_SHOWN && (
            <div className="mt-3 flex items-center justify-between border-t pt-2 text-xs text-muted-foreground">
              <span>
                {showAll ? `All ${num(a.areas.length)} areas` : `Top ${AREAS_SHOWN} of ${num(a.areas.length)} areas`}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowAll((v) => !v)}
                data-testid="md-activity-areas-more"
              >
                {showAll ? "Show fewer" : "Show all"}
              </Button>
            </div>
          )}
        </>
      ) : null}
    </SectionCard>
  );
}
