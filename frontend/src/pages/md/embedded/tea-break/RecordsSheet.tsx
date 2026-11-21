import { useState } from "react";
import { describeMdError, useMdQuery, type MdQueryParams } from "@/lib/api-client/custom-hooks/md";
import { clockText, dayShort } from "@/lib/md/format";
import DetailSheet, { DetailList, DetailRow } from "../shared/DetailSheet";
import { employeeAddress, useOpenInPage } from "../shared/jump";
import { mins } from "../outpass/logic";
import { Pager } from "../outpass/parts";
import type { TeaRecord, TeaRecords } from "./types";

/** What a click asks for: the sheet's title and the records filter (status, by + group, employee). */
export type TeaDrill = { title: string; filter: Record<string, string | number> };

const PAGE_SIZE = 25;

const TONE: Partial<Record<TeaRecord["status"], string>> = {
  overrun: "md-analytics-tone-bad",
  long: "md-analytics-tone-watch",
  no_return: "md-analytics-tone-watch",
  refused: "md-analytics-tone-bad",
  within: "md-analytics-tone-good",
};

function when(r: TeaRecord): string {
  if (r.status === "refused") return `${dayShort(r.date)} · refused at ${clockText(r.outAt)}`;
  if (r.inAt) return `${dayShort(r.date)} · ${clockText(r.outAt)} to ${clockText(r.inAt)} (${mins(r.minutes)})`;
  return `${dayShort(r.date)} · out ${clockText(r.outAt)}`;
}

/**
 * The breaks behind a figure, a group or an employee (or the codes a gate refused): newest first, 25 at a time. A break
 * opens its employee's record; "Open in Tea Break" goes to the HR page's records.
 */
export default function RecordsSheet({
  drill,
  params,
  onClose,
}: {
  drill: TeaDrill | null;
  params: MdQueryParams;
  onClose: () => void;
}) {
  const [page, setPage] = useState(1);
  const [shown, setShown] = useState<TeaDrill | null>(drill);
  if (drill && drill !== shown) {
    setShown(drill);
    setPage(1);
  }
  const open = useOpenInPage();
  const query = useMdQuery<TeaRecords>(
    "tea-break/records",
    { ...params, ...(shown?.filter ?? {}), page, pageSize: PAGE_SIZE },
    { enabled: drill !== null && shown !== null },
  );
  const data = query.data;
  return (
    <DetailSheet
      open={drill !== null}
      onClose={onClose}
      title={shown?.title ?? "Tea breaks"}
      subtitle={data ? [data.period?.label, ...data.filters].filter(Boolean).join(" · ") : undefined}
      loading={query.isPending}
      error={query.isError ? describeMdError(query.error) : null}
      onRetry={() => void query.refetch()}
      empty={data && data.total === 0 ? "No tea breaks match this." : null}
      openLabel="Open in Tea Break"
      onOpen={() => open("/md/outpass-visitors/tea-break/records")}
      ask={
        shown ? `Tell me about these tea breaks: ${shown.title} (${data?.period?.label ?? "this period"}).` : undefined
      }
      testId="md-tea-sheet"
      wide
    >
      {data && (
        <div className="space-y-3">
          <DetailList testId="md-tea-sheet-rows">
            {data.items.map((r) => (
              <DetailRow
                key={r.id}
                testId={`md-tea-row-${r.id}`}
                primary={
                  r.employeeName
                    ? `${r.employeeName}${r.employeeCode ? ` (${r.employeeCode})` : ""} · ${r.department}`
                    : "Unknown code"
                }
                secondary={`${when(r)}${r.outGate ? ` · ${r.outGate}` : ""}`}
                value={r.overMinutes ? `${r.statusLabel} (+${r.overMinutes}m)` : r.statusLabel}
                tone={TONE[r.status]}
                onClick={r.employeeId ? () => open(employeeAddress(r.employeeId as number)) : undefined}
              />
            ))}
          </DetailList>
          <Pager
            page={data.page}
            pageSize={data.pageSize}
            total={data.total}
            hasMore={data.hasMore}
            onPage={setPage}
            testId="md-tea-sheet-pager"
          />
        </div>
      )}
    </DetailSheet>
  );
}
