import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { GateRange, OutpassRecordRow, PaginatedRecords } from "@/lib/api-client/custom-hooks";
import { DateTimeStack, PASS_TD, PASS_TH, RANGE_LABEL, RecordsPagination } from "../shared";

// The exits logged through the branch's permanent QR form: no approval step, no attendance or payroll impact. The page and the
// list come from the Overview (it also counts them on its tab), so this only draws them.
export function QrSubmissionsSection({
  range,
  records: page_,
  isLoading: recordsLoading,
  setPage,
}: {
  range: GateRange;
  records: PaginatedRecords<OutpassRecordRow> | undefined;
  isLoading: boolean;
  setPage: (page: number) => void;
}) {
  const records: OutpassRecordRow[] = page_?.items ?? [];
  return (
    <Card data-testid="outpass-qr-submissions">
      <CardContent className="p-0">
        <div className="flex items-center justify-between gap-3 px-4 pt-4 pb-3">
          <div>
            <p className="font-bold text-sm">Gate QR Submissions</p>
            <p className="text-xs text-muted-foreground">
              Exits logged through the branch QR form, with no approval step and no attendance or payroll impact.
              Showing {RANGE_LABEL[range].toLowerCase()}.
            </p>
          </div>
          {page_ && (
            <Badge variant="secondary" className="shrink-0 whitespace-nowrap">
              {page_.total} {page_.total === 1 ? "submission" : "submissions"}
            </Badge>
          )}
        </div>
        <div className="overflow-x-auto border-t">
          <Table className="min-w-[860px] table-fixed">
            <TableHeader>
              <TableRow className="bg-muted/30 hover:bg-muted/30">
                <TableHead className={`${PASS_TH} w-[230px]`}>Employee</TableHead>
                <TableHead className={`${PASS_TH} w-[110px]`}>Code</TableHead>
                <TableHead className={PASS_TH}>Destination</TableHead>
                <TableHead className={`${PASS_TH} w-[170px]`}>Branch</TableHead>
                <TableHead className={`${PASS_TH} w-[110px]`}>Submitted</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recordsLoading && !page_ ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-10 text-muted-foreground">
                    Loading…
                  </TableCell>
                </TableRow>
              ) : !records.length ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-10 text-muted-foreground">
                    No gate QR submissions for {RANGE_LABEL[range].toLowerCase()}.
                  </TableCell>
                </TableRow>
              ) : (
                records.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className={`${PASS_TD} font-medium`}>
                      <p className="truncate" title={r.employeeName}>
                        {r.employeeName}
                      </p>
                    </TableCell>
                    <TableCell className={`${PASS_TD} whitespace-nowrap`}>{r.employeeCode}</TableCell>
                    <TableCell className={`${PASS_TD} break-words`}>{r.destination}</TableCell>
                    <TableCell className={`${PASS_TD} whitespace-nowrap`}>
                      <p className="truncate" title={r.branchName ?? undefined}>
                        {r.branchName ?? "—"}
                      </p>
                    </TableCell>
                    <TableCell className={PASS_TD}>
                      <DateTimeStack iso={r.submittedAt} />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
        {page_ && (
          <RecordsPagination page={page_.page} total={page_.total} pageSize={page_.pageSize} onPageChange={setPage} />
        )}
      </CardContent>
    </Card>
  );
}
