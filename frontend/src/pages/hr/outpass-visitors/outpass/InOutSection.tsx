import { useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useListOutpassRequests, type OutpassRequestItem } from "@/lib/api-client/custom-hooks";
import { RecordsPagination, fmtDateTime } from "../shared";
import { SCAN_STATUS_BADGE, fmtDuration, formatApprover } from "./logic";

// ── In/Out (exit + return leg, one row per employee who has actually exited
//    at least once) -reuses the exact same useListOutpassRequests() data as
//    ApprovedPassesSection (Outpass > Overview > Passes), just filtered to rows with
//    an exitedAt and reshaped around the Name/Department/Gate/Scan Status/
//    Approved By/Exit Time/In Time/Taken Time columns the user asked for.
//    No new backend endpoint -every field it needs is already on
//    OutpassRequestItem. ─────────────────────────────────────────────────

const INOUT_PAGE_SIZE = 20;

export function InOutSection() {
  const [page, setPage] = useState(1);
  const { data: requests, isLoading } = useListOutpassRequests();
  const rows: OutpassRequestItem[] = (requests ?? []).filter((r) => !!r.exitedAt);
  const pageCount = Math.max(1, Math.ceil(rows.length / INOUT_PAGE_SIZE));
  const pageSafe = Math.min(page, pageCount);
  const pageRows = rows.slice((pageSafe - 1) * INOUT_PAGE_SIZE, pageSafe * INOUT_PAGE_SIZE);

  return (
    <Card data-testid="outpass-in-out">
      <CardContent className="p-0">
        <div className="px-4 pt-4 pb-2">
          <p className="font-bold text-sm">In / Out</p>
          <p className="text-xs text-muted-foreground">
            Every recorded gate exit, and its return if scanned back in yet -with how long each employee was outside.
          </p>
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Department</TableHead>
                <TableHead>Gate</TableHead>
                <TableHead>Scan Status</TableHead>
                <TableHead>Approved By</TableHead>
                <TableHead>Exit Time</TableHead>
                <TableHead>In Time</TableHead>
                <TableHead>Taken Time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-10 text-muted-foreground">
                    Loading…
                  </TableCell>
                </TableRow>
              ) : !rows.length ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-10 text-muted-foreground">
                    No gate exits recorded yet.
                  </TableCell>
                </TableRow>
              ) : (
                pageRows.map((r) => {
                  const scan = SCAN_STATUS_BADGE[r.scanStatus] ?? SCAN_STATUS_BADGE.not_applicable;
                  const stillOut = !r.enteredAt;
                  return (
                    <TableRow key={r.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Avatar className="size-7">
                            <AvatarImage src={r.employee?.photoUrl ?? undefined} />
                            <AvatarFallback className="text-[10px]">{r.employee?.name?.[0] ?? "?"}</AvatarFallback>
                          </Avatar>
                          <div className="min-w-0">
                            <p className="font-medium truncate">{r.employee?.name ?? `#${r.employeeId}`}</p>
                            <p className="text-xs text-muted-foreground">{r.employee?.employeeCode}</p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{r.employee?.department ?? "—"}</TableCell>
                      <TableCell>
                        <p>{r.exitGateName ?? "—"}</p>
                        {r.entryGateName && r.entryGateName !== r.exitGateName && (
                          <p className="text-xs text-muted-foreground">back via {r.entryGateName}</p>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge className={`text-xs border ${scan.cls}`}>{scan.label}</Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatApprover(r.approverRole, r.approvedBy)}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {r.exitedAt ? fmtDateTime(r.exitedAt) : "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {r.enteredAt ? fmtDateTime(r.enteredAt) : "—"}
                      </TableCell>
                      <TableCell>
                        <span className={stillOut ? "text-amber-600 font-medium" : "text-muted-foreground"}>
                          {fmtDuration(r.exitedAt!, r.enteredAt)}
                          {stillOut ? " (still out)" : ""}
                        </span>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
        {rows.length > 0 && (
          <RecordsPagination page={pageSafe} total={rows.length} pageSize={INOUT_PAGE_SIZE} onPageChange={setPage} />
        )}
      </CardContent>
    </Card>
  );
}
