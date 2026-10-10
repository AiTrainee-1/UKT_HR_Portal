import { useState } from "react";
import { Boxes } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import BarList from "@/components/md/kit/BarList";
import SectionCard from "@/components/md/kit/SectionCard";
import { EmptyBlock, ErrorBanner } from "@/components/md/kit/states";
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
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-md-line pt-3 text-xs font-medium text-md-ink-soft">
              <span>
                {showAll ? `All ${num(a.areas.length)} areas` : `Top ${AREAS_SHOWN} of ${num(a.areas.length)} areas`}
              </span>
              <button
                type="button"
                onClick={() => setShowAll((v) => !v)}
                data-testid="md-activity-areas-more"
                className="md-btn md-btn-soft md-btn-sm min-h-9"
              >
                {showAll ? "Show fewer" : "Show all"}
              </button>
            </div>
          )}
        </>
      ) : null}
    </SectionCard>
  );
}
