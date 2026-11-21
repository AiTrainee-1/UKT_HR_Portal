import { useState } from "react";
import { describeMdError, useMdQuery, type MdQueryParams } from "@/lib/api-client/custom-hooks/md";
import { dayLong, num } from "@/lib/md/format";
import DetailSheet, { DetailList, DetailRow } from "../shared/DetailSheet";
import { employeeAddress, useOpenInPage } from "../shared/jump";
import { MARK_LABEL, MARK_TONE } from "./scheduled-logic";
import type { AbsenceMark, RlAbsences } from "./types";

export type AbsenceFilter = { mark: AbsenceMark; day?: string; title: string };

const MARK_WORD = { informed: "Informed", not_informed: "Not informed", unmarked: "Not marked" } as const;

/** The absences behind a figure (a mark, a gap day), newest first, a page at a time; a person opens their record, and the
 *  Report Log itself is one click away. */
export default function AbsencesSheet({
  filter,
  params,
  onClose,
}: {
  filter: AbsenceFilter | null;
  params: MdQueryParams;
  onClose: () => void;
}) {
  const [page, setPage] = useState(1);
  const [shown, setShown] = useState(filter);
  if (filter && filter !== shown) {
    setShown(filter);
    setPage(1);
  }
  const query = useMdQuery<RlAbsences>(
    "reportlog/absences",
    { ...params, mark: shown?.mark ?? "all", day: shown?.day, page, pageSize: 25 },
    { enabled: !!shown },
  );
  const openPage = useOpenInPage();
  const data = query.data;
  return (
    <DetailSheet
      open={!!filter}
      onClose={onClose}
      title={shown?.title ?? MARK_LABEL.all}
      subtitle={
        data
          ? `${num(data.total)} ${data.total === 1 ? "absence" : "absences"} · ${shown?.day ? dayLong(shown.day) : (data.period?.label ?? "")}`
          : undefined
      }
      loading={query.isPending}
      error={query.isError ? describeMdError(query.error) : null}
      onRetry={() => void query.refetch()}
      empty={data && data.total === 0 ? "No absence matches this selection." : null}
      openLabel="Open the Report Log"
      onOpen={() => openPage("/md/attendance/report-log")}
      ask={`Who are the absences "${shown?.title ?? ""}" (${data?.period?.label ?? "this period"}), are some people absent again and again, and were they followed up?`}
      testId="md-reportlog-absences-sheet"
      wide
    >
      {data && (
        <>
          <DetailList testId="md-reportlog-absences-rows">
            {data.rows.map((r) => (
              <DetailRow
                key={`${r.date}-${r.employeeId}`}
                testId={`md-reportlog-absence-${r.employeeCode}-${r.date}`}
                primary={`${r.employeeName} · ${r.weekday} ${dayLong(r.date)}`}
                secondary={[
                  r.employeeCode,
                  r.department,
                  r.unit,
                  r.absencesInSelection > 1 ? `absent ${num(r.absencesInSelection)} times in this selection` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
                value={MARK_WORD[r.mark]}
                tone={MARK_TONE[r.mark]}
                onClick={() => openPage(employeeAddress(r.employeeId))}
              />
            ))}
          </DetailList>
          {data.pages > 1 && (
            <div className="flex items-center justify-between gap-2 text-xs text-md-ink-soft">
              <button
                type="button"
                className="md-btn h-9 rounded-lg px-3 font-semibold disabled:opacity-40"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </button>
              <span>
                Page {num(data.page)} of {num(data.pages)}
              </span>
              <button
                type="button"
                className="md-btn h-9 rounded-lg px-3 font-semibold disabled:opacity-40"
                disabled={page >= data.pages}
                onClick={() => setPage((p) => p + 1)}
                data-testid="md-reportlog-absences-next"
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </DetailSheet>
  );
}
