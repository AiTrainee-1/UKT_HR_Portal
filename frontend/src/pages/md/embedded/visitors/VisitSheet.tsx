import { useState } from "react";
import { describeMdError, useMdQuery, type MdQueryParams } from "@/lib/api-client/custom-hooks/md";
import { clockText, dayShort } from "@/lib/md/format";
import DetailSheet, { DetailList, DetailRow } from "../shared/DetailSheet";
import { employeeAddress, useOpenInPage } from "../shared/jump";
import { mins } from "../outpass/logic";
import { Pager } from "../outpass/parts";
import type { VisitItem, VisitList } from "../outpass/types";

/** What a click asks for: the sheet's title and the visit-list filter (status, purpose, source, desk, host, afterHours). */
export type VisitDrill = { title: string; filter: Record<string, string | number> };

const PAGE_SIZE = 25;

function when(item: VisitItem): string {
  const day = dayShort(item.visitedAt);
  if (item.checkedOutAt) {
    return `${day} · in ${clockText(item.visitedAt)}, out ${clockText(item.checkedOutAt)} (${mins(item.minutesInside)})`;
  }
  if (item.status === "inside") return `${day} · in ${clockText(item.visitedAt)}, inside ${mins(item.minutesInside)}`;
  return `${day} · in ${clockText(item.visitedAt)}`;
}

/**
 * The visits behind a figure, a purpose, a desk or a host: newest first, 25 at a time, with check-in and check-out. A
 * visit to an employee opens that employee's record; "Open in Visitors" goes to the HR page's visits.
 */
export default function VisitSheet({
  drill,
  params,
  onClose,
}: {
  drill: VisitDrill | null;
  params: MdQueryParams;
  onClose: () => void;
}) {
  const [page, setPage] = useState(1);
  const [shown, setShown] = useState<VisitDrill | null>(drill);
  if (drill && drill !== shown) {
    setShown(drill);
    setPage(1);
  }
  const open = useOpenInPage();
  const query = useMdQuery<VisitList>(
    "visitors/visit-list",
    { ...params, ...(shown?.filter ?? {}), page, pageSize: PAGE_SIZE },
    { enabled: drill !== null && shown !== null },
  );
  const data = query.data;
  return (
    <DetailSheet
      open={drill !== null}
      onClose={onClose}
      title={shown?.title ?? "Visits"}
      subtitle={data ? [data.period?.label, ...data.filters].filter(Boolean).join(" · ") : undefined}
      loading={query.isPending}
      error={query.isError ? describeMdError(query.error) : null}
      onRetry={() => void query.refetch()}
      empty={data && data.total === 0 ? "No visits match this." : null}
      openLabel="Open in Visitors"
      onOpen={() => open("/md/outpass-visitors/visitors/visits")}
      ask={shown ? `Tell me about these visits: ${shown.title} (${data?.period?.label ?? "this period"}).` : undefined}
      testId="md-visitors-sheet"
      wide
    >
      {data && (
        <div className="space-y-3">
          <DetailList testId="md-visitors-sheet-rows">
            {data.items.map((item) => (
              <DetailRow
                key={item.visitId}
                testId={`md-visitors-row-${item.visitId}`}
                primary={`${item.visitorName ?? "Visitor"}${item.company ? ` · ${item.company}` : ""} → ${item.hostName ?? "—"}`}
                secondary={`${when(item)} · ${item.purposeCategory}${item.desk ? ` · ${item.desk}` : ` · ${item.sourceLabel}`}`}
                value={item.statusLabel}
                onClick={item.hostEmployeeId ? () => open(employeeAddress(item.hostEmployeeId as number)) : undefined}
              />
            ))}
          </DetailList>
          <Pager
            page={data.page}
            pageSize={data.pageSize}
            total={data.total}
            hasMore={data.hasMore}
            onPage={setPage}
            testId="md-visitors-sheet-pager"
          />
        </div>
      )}
    </DetailSheet>
  );
}
