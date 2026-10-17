import { useMemo, useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useListOutpassRequests, type GateRange, type OutpassRequestItem } from "@/lib/api-client/custom-hooks";
import { inGateRange } from "@/lib/gate-range";
import { DateTimeStack, PAGE_SIZE, PASS_TD, PASS_TH, RANGE_LABEL, RecordsPagination } from "../shared";
import { APPROVAL_STATUS_CLS, SCAN_STATUS_BADGE, formatApprover } from "./logic";

// A pass normally expires the same day it was requested, so only the time is shown; the date is
// added only when it is a different day.
function ExpiryCell({ createdAt, expiresAt }: { createdAt: string; expiresAt?: string | null }) {
  if (!expiresAt) return <span className="text-muted-foreground">—</span>;
  const created = new Date(createdAt);
  const expires = new Date(expiresAt);
  if (isNaN(expires.getTime())) return <span className="whitespace-nowrap">{expiresAt}</span>;
  if (!isNaN(created.getTime()) && created.toDateString() === expires.toDateString()) {
    return (
      <span className="whitespace-nowrap text-muted-foreground">
        {expires.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
      </span>
    );
  }
  return <DateTimeStack iso={expiresAt} />;
}

export function ApprovedPassesSection({ range }: { range: GateRange }) {
  const [page, setPage] = useState(1);
  const { data: requests, isLoading } = useListOutpassRequests();
  // The Today / This Week / This Month pills apply here too (the same Asia/Kolkata boundaries the
  // server uses for the Gate QR submissions list) -this list comes flat from the API, so it is
  // filtered here. Newest first, so today's passes are at the top.
  const rows: OutpassRequestItem[] = useMemo(
    () =>
      (requests ?? [])
        .filter((r) => inGateRange(r.createdAt, range))
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
    [requests, range],
  );
  const totalEver = requests?.length ?? 0;
  // Client-side paging, same reasoning as OutpassRequestsSection below -this
  // endpoint also serves the Mobile/Web apps' own flat "my requests" array,
  // so it can't switch to a {items,total,page,pageSize} response shape
  // without breaking them.
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageSafe = Math.min(page, pageCount);
  const pageRows = rows.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE);
  const rangeText = RANGE_LABEL[range].toLowerCase();

  return (
    <Card data-testid="outpass-passes">
      <CardContent className="p-0">
        <div className="flex items-center justify-between gap-3 px-4 pt-4 pb-3">
          <div>
            <p className="font-bold text-sm">Outpass Requests</p>
            <p className="text-xs text-muted-foreground">
              Passes that go through approval (HR, Department Head or On-Duty), with live gate-scan and exit status.
              Showing {rangeText}.
            </p>
          </div>
          {!isLoading && (
            <Badge variant="secondary" className="shrink-0 whitespace-nowrap">
              {rows.length} {rows.length === 1 ? "pass" : "passes"}
            </Badge>
          )}
        </div>
        <div className="overflow-x-auto border-t">
          <Table className="min-w-[1260px] table-fixed">
            <TableHeader>
              <TableRow className="bg-muted/30 hover:bg-muted/30">
                <TableHead className={`${PASS_TH} w-[210px]`}>Employee</TableHead>
                <TableHead className={`${PASS_TH} w-[130px]`}>Department</TableHead>
                <TableHead className={`${PASS_TH} w-[230px]`}>Destination / Reason</TableHead>
                <TableHead className={`${PASS_TH} w-[90px]`}>Requested</TableHead>
                <TableHead className={`${PASS_TH} w-[90px]`}>Expires</TableHead>
                <TableHead className={`${PASS_TH} w-[150px]`}>Approval</TableHead>
                <TableHead className={`${PASS_TH} w-[110px]`}>Gate</TableHead>
                <TableHead className={`${PASS_TH} w-[160px]`}>Scan Status</TableHead>
                <TableHead className={`${PASS_TH} w-[90px]`}>Exit Time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center py-10 text-muted-foreground">
                    Loading…
                  </TableCell>
                </TableRow>
              ) : !rows.length ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center py-10 text-muted-foreground">
                    No outpass requests for {rangeText}.{totalEver > 0 && " Try a wider range."}
                  </TableCell>
                </TableRow>
              ) : (
                pageRows.map((r) => {
                  const scan = SCAN_STATUS_BADGE[r.scanStatus] ?? SCAN_STATUS_BADGE.not_applicable;
                  const approver = formatApprover(r.approverRole, r.approvedBy);
                  const showReason = !!r.reason && r.reason.trim() !== (r.destination ?? "").trim();
                  return (
                    <TableRow key={r.id}>
                      <TableCell className={PASS_TD}>
                        <div className="flex min-w-0 items-center gap-2.5">
                          <Avatar className="size-8 shrink-0">
                            <AvatarImage src={r.employee?.photoUrl ?? undefined} />
                            <AvatarFallback className="text-[10px]">{r.employee?.name?.[0] ?? "?"}</AvatarFallback>
                          </Avatar>
                          <div className="min-w-0 leading-tight">
                            <p className="font-medium truncate" title={r.employee?.name}>
                              {r.employee?.name ?? `#${r.employeeId}`}
                            </p>
                            <p className="text-xs text-muted-foreground truncate">{r.employee?.employeeCode}</p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className={`${PASS_TD} text-muted-foreground`}>
                        <p className="truncate" title={r.employee?.department ?? undefined}>
                          {r.employee?.department ?? "—"}
                        </p>
                      </TableCell>
                      <TableCell className={PASS_TD}>
                        <div className="leading-tight">
                          <p className="font-medium truncate" title={r.destination}>
                            {r.destination}
                          </p>
                          {showReason && (
                            <p className="text-xs text-muted-foreground truncate" title={r.reason}>
                              {r.reason}
                            </p>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className={PASS_TD}>
                        <DateTimeStack iso={r.createdAt} />
                      </TableCell>
                      <TableCell className={PASS_TD}>
                        <ExpiryCell createdAt={r.createdAt} expiresAt={r.expiresAt} />
                      </TableCell>
                      <TableCell className={PASS_TD}>
                        <div className="flex min-w-0 flex-col items-start gap-1">
                          <Badge
                            className={`text-xs border capitalize whitespace-nowrap ${APPROVAL_STATUS_CLS[r.status] ?? APPROVAL_STATUS_CLS.pending}`}
                          >
                            {r.status}
                          </Badge>
                          {approver !== "—" && (
                            <span className="max-w-full truncate text-xs text-muted-foreground" title={approver}>
                              {approver}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className={PASS_TD}>
                        <p className="truncate" title={r.exitGateName ?? undefined}>
                          {r.exitGateName ?? "—"}
                        </p>
                      </TableCell>
                      <TableCell className={PASS_TD}>
                        <Badge className={`text-xs border whitespace-nowrap ${scan.cls}`}>{scan.label}</Badge>
                      </TableCell>
                      <TableCell className={PASS_TD}>
                        <DateTimeStack iso={r.exitedAt} />
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
        {rows.length > 0 && (
          <RecordsPagination page={pageSafe} total={rows.length} pageSize={PAGE_SIZE} onPageChange={setPage} />
        )}
      </CardContent>
    </Card>
  );
}
