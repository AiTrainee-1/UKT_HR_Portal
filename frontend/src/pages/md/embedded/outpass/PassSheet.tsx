import { useState } from "react";
import { useMdQuery, describeMdError, type MdQueryParams } from "@/lib/api-client/custom-hooks/md";
import { clockText, dayShort } from "@/lib/md/format";
import DetailSheet, { DetailList, DetailRow } from "../shared/DetailSheet";
import { employeeAddress, useOpenInPage } from "../shared/jump";
import { mins } from "./logic";
import { Pager } from "./parts";
import type { PassItem, PassList } from "./types";

/** What a click asks for: the sheet's title, and the pass-list filter (outcome, departmentName, reason, gate, employee). */
export type PassDrill = { title: string; filter: Record<string, string | number> };

const PAGE_SIZE = 25;

function when(item: PassItem): string {
  const day = dayShort(item.requestedAt);
  if (item.exitedAt && item.enteredAt) {
    return `${day} · out ${clockText(item.exitedAt)}, back ${clockText(item.enteredAt)} (${mins(item.minutesOut)})`;
  }
  if (item.exitedAt) return `${day} · out ${clockText(item.exitedAt)}`;
  return `${day} · requested ${clockText(item.requestedAt)}`;
}

/**
 * The gate passes behind a figure, a group or an employee: newest first, 25 at a time. A pass opens its employee's record;
 * "Open in Gate Pass" goes to the In/Out tab of the HR page. A rejected pass shows the reason the reviewer gave.
 */
export default function PassSheet({
  drill,
  params,
  onClose,
}: {
  drill: PassDrill | null;
  params: MdQueryParams;
  onClose: () => void;
}) {
  const [page, setPage] = useState(1);
  const [shown, setShown] = useState<PassDrill | null>(drill);
  if (drill && drill !== shown) {
    setShown(drill);
    setPage(1);
  }
  const open = useOpenInPage();
  const query = useMdQuery<PassList>(
    "visitors/pass-list",
    { ...params, ...(shown?.filter ?? {}), page, pageSize: PAGE_SIZE },
    { enabled: drill !== null && shown !== null },
  );
  const data = query.data;
  return (
    <DetailSheet
      open={drill !== null}
      onClose={onClose}
      title={shown?.title ?? "Gate passes"}
      subtitle={data ? [data.period?.label, ...data.filters].filter(Boolean).join(" · ") : undefined}
      loading={query.isPending}
      error={query.isError ? describeMdError(query.error) : null}
      onRetry={() => void query.refetch()}
      empty={data && data.total === 0 ? "No gate passes match this." : null}
      openLabel="Open in Gate Pass"
      onOpen={() => open("/md/outpass-visitors/outpass/in-out")}
      ask={
        shown ? `Tell me about these gate passes: ${shown.title} (${data?.period?.label ?? "this period"}).` : undefined
      }
      testId="md-gate-pass-sheet"
      wide
    >
      {data && (
        <div className="space-y-3">
          <DetailList testId="md-gate-pass-sheet-rows">
            {data.items.map((item) => (
              <DetailRow
                key={item.passId}
                testId={`md-gate-pass-row-${item.passId}`}
                primary={`${item.name}${item.code ? ` (${item.code})` : ""} · ${item.department}`}
                secondary={
                  <>
                    {when(item)}
                    {item.destination ? ` · ${item.destination}` : ""}
                    {item.exitGate ? ` · ${item.exitGate}` : ""}
                    {item.reviewComment ? ` · Reason: ${item.reviewComment}` : ""}
                  </>
                }
                value={item.outcomeLabel}
                onClick={() => open(employeeAddress(item.employeeId))}
              />
            ))}
          </DetailList>
          <Pager
            page={data.page}
            pageSize={data.pageSize}
            total={data.total}
            hasMore={data.hasMore}
            onPage={setPage}
            testId="md-gate-pass-sheet-pager"
          />
        </div>
      )}
    </DetailSheet>
  );
}
