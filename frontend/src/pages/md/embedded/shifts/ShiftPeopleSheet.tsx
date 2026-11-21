import { useState } from "react";
import { describeMdError, useMdQuery, type MdQueryParams } from "@/lib/api-client/custom-hooks/md";
import { num } from "@/lib/md/format";
import DetailSheet, { DetailList, DetailRow } from "../shared/DetailSheet";
import { employeeAddress, useOpenInPage } from "../shared/jump";
import { Pager } from "../employees/kit";
import { spanText } from "./logic";
import type { ShiftPeople } from "./types";

/** The people on one shift today (GET /api/md/shifts/people?shift=<key>), each opening their record. */
export default function ShiftPeopleSheet({
  shift,
  scope,
  onClose,
}: {
  shift: string | null;
  scope: MdQueryParams;
  onClose: () => void;
}) {
  const open = useOpenInPage();
  const [page, setPage] = useState(1);
  const [shown, setShown] = useState(shift);
  if (shift && shift !== shown) {
    setShown(shift);
    setPage(1);
  }
  const key = shift ?? shown;
  const query = useMdQuery<ShiftPeople>(
    "shifts/people",
    key ? { ...scope, shift: key, page, pageSize: 25 } : undefined,
    { enabled: shift != null },
  );
  const data = query.data;
  return (
    <DetailSheet
      open={shift != null}
      onClose={onClose}
      title={data?.shift.label ?? "People on the shift"}
      subtitle={data ? `${num(data.total)} ${data.total === 1 ? "person" : "people"} today` : undefined}
      loading={query.isPending || (query.isPlaceholderData && query.isFetching)}
      error={query.isError ? describeMdError(query.error) : null}
      onRetry={() => void query.refetch()}
      empty={data && data.total === 0 ? (data.notes[0] ?? "Nobody is on this shift today.") : null}
      openLabel="Open in Manage Shift"
      onOpen={() => open("/md/shifts")}
      ask={data ? `Who is on ${data.shift.label} today, and is it staffed right?` : undefined}
      testId="md-shifts-people"
      wide
    >
      {data && (
        <div className="space-y-3">
          <DetailList testId="md-shifts-people-rows">
            {data.rows.map((r) => (
              <DetailRow
                key={r.employeeId}
                testId={`md-shifts-people-row-${r.employeeId}`}
                primary={`${r.employeeName} · ${r.employeeCode}`}
                secondary={[r.department, r.unit, r.type].filter(Boolean).join(" · ")}
                value={spanText(r)}
                onClick={() => open(employeeAddress(r.employeeId))}
              />
            ))}
          </DetailList>
          <Pager
            page={data.page}
            pages={data.pages}
            total={data.total}
            onPage={setPage}
            testId="md-shifts-people-pager"
          />
        </div>
      )}
    </DetailSheet>
  );
}
