import { QrCode } from "lucide-react";
import type { OutpassRecordRow, PaginatedRecords } from "@/lib/api-client/custom-hooks";
import { DataTable, WhenCell, fmtCount, type DataColumn } from "../kit";

const COLUMNS: DataColumn<OutpassRecordRow>[] = [
  {
    key: "name",
    header: "Employee",
    cell: (r) => <span className="font-medium text-slate-900">{r.employeeName}</span>,
    text: (r) => r.employeeName,
    minWidth: 160,
    maxWidth: 240,
  },
  {
    key: "code",
    header: "Code",
    cell: (r) => <span className="font-mono text-xs">{r.employeeCode}</span>,
    maxWidth: 120,
  },
  { key: "destination", header: "Destination", cell: (r) => r.destination, text: (r) => r.destination, maxWidth: 280 },
  {
    key: "branch",
    header: "Branch",
    cell: (r) => r.branchName ?? "—",
    text: (r) => r.branchName,
    hideOnPhone: true,
    maxWidth: 180,
  },
  { key: "submitted", header: "Submitted", cell: (r) => <WhenCell value={r.submittedAt} /> },
];

// The exits logged through the branch's permanent QR form: no approval step, no attendance or payroll impact. The page and the
// list come from the Overview (it also counts them on its tab), so this only draws them.
export function QrSubmissionsSection({
  rangeText,
  records: page_,
  isLoading,
  setPage,
}: {
  /** The days of the date filter in words ("November 2026"). */
  rangeText: string;
  records: PaginatedRecords<OutpassRecordRow> | undefined;
  isLoading: boolean;
  setPage: (page: number) => void;
}) {
  const total = page_?.total ?? 0;
  return (
    <DataTable
      columns={COLUMNS}
      rows={page_?.items}
      rowKey={(r) => r.id}
      loading={isLoading}
      summary={
        page_ ? (
          <span>
            <strong className="font-semibold text-slate-900">
              {fmtCount(total)} {total === 1 ? "submission" : "submissions"}
            </strong>{" "}
            · {rangeText} · logged through the branch QR form, with no approval step
          </span>
        ) : null
      }
      empty={{
        icon: QrCode,
        title: `No gate QR submissions for ${rangeText}`,
        hint: "People who scan the branch's gate QR and fill in the form are listed here.",
      }}
      pagination={
        page_ ? { page: page_.page, pageSize: page_.pageSize, total: page_.total, onPageChange: setPage } : undefined
      }
      caption="Gate QR submissions"
      testId="outpass-qr-submissions"
    />
  );
}
