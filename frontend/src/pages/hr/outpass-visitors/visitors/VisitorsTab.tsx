import { useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  useVisitorQr,
  useVisitorSummary,
  useVisitorRecords,
  type GateRange,
  type VisitorRecordRow,
} from "@/lib/api-client/custom-hooks";
import { Eye, EyeOff, Mail, MessageCircle } from "lucide-react";
import { GateQrDialog } from "../GateQrDialog";
import { ReceptionDevicesDialog } from "../ReceptionDevicesDialog";
import {
  BranchPicker,
  KpiRow,
  PAGE_SIZE,
  RANGE_LABEL,
  RangeFilter,
  RecordsPagination,
  fmtDateTime,
  useSelectedBranch,
} from "../shared";

// ── Visitors tab ──────────────────────────────────────────────────────────

export function VisitorsTab({ isBranchScoped }: { isBranchScoped: boolean }) {
  const [range, setRange] = useState<GateRange>("today");
  const [page, setPage] = useState(1);
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const { branches, branchId, setBranchId } = useSelectedBranch(isBranchScoped);
  const effectiveBranchId = isBranchScoped ? undefined : branchId ? Number(branchId) : undefined;

  const { data: qr } = useVisitorQr(effectiveBranchId);
  const { data: summary, isLoading: summaryLoading } = useVisitorSummary();
  const { data: page_, isLoading: recordsLoading } = useVisitorRecords(range, page, PAGE_SIZE);
  const records: VisitorRecordRow[] = page_?.items ?? [];

  const changeRange = (v: GateRange) => {
    setRange(v);
    setPage(1);
  };
  const toggleReveal = (id: number) => {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      <KpiRow summary={summary} isLoading={summaryLoading} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <RangeFilter value={range} onChange={changeRange} />
        <div className="flex flex-wrap items-center gap-2">
          {!isBranchScoped && <BranchPicker branches={branches} branchId={branchId} setBranchId={setBranchId} />}
          <ReceptionDevicesDialog isBranchScoped={isBranchScoped} branches={branches} defaultBranchId={branchId} />
          <GateQrDialog kind="visitor" token={qr?.token} branchName={qr?.branchName} />
        </div>
      </div>

      <Card data-testid="visitors-list">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Visitor</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Aadhaar</TableHead>
                  <TableHead>Meeting</TableHead>
                  <TableHead>Purpose</TableHead>
                  <TableHead>Notified</TableHead>
                  <TableHead>Branch</TableHead>
                  <TableHead>Visited</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recordsLoading && !page_ ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center py-10 text-muted-foreground">
                      Loading…
                    </TableCell>
                  </TableRow>
                ) : !records.length ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center py-10 text-muted-foreground">
                      No visitor records for {RANGE_LABEL[range].toLowerCase()}.
                    </TableCell>
                  </TableRow>
                ) : (
                  records.map((r) => {
                    const isRevealed = revealed.has(r.id);
                    const emp = r.meetingEmployee;
                    return (
                      <TableRow key={r.id}>
                        <TableCell className="font-medium">{r.name}</TableCell>
                        <TableCell>{r.phone}</TableCell>
                        <TableCell className="tracking-wider">
                          {r.aadhaarLast4 ? (
                            <button
                              type="button"
                              onClick={() => toggleReveal(r.id)}
                              className="inline-flex items-center gap-1.5 hover:text-foreground text-muted-foreground"
                              title={isRevealed ? "Hide Aadhaar number" : "Reveal Aadhaar number"}
                            >
                              <span className="font-mono">
                                {isRevealed && r.aadhaar ? r.aadhaar : `••••${r.aadhaarLast4}`}
                              </span>
                              {isRevealed ? <EyeOff size={13} /> : <Eye size={13} />}
                            </button>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                        <TableCell>
                          {emp ? (
                            <div className="flex items-center gap-2">
                              <Avatar className="size-7">
                                <AvatarImage src={emp.photoUrl ?? undefined} />
                                <AvatarFallback className="text-[10px]">{emp.name[0]}</AvatarFallback>
                              </Avatar>
                              <div className="min-w-0">
                                <p className="truncate font-medium">{emp.name}</p>
                                <p className="text-xs text-muted-foreground">{emp.department ?? emp.employeeCode}</p>
                              </div>
                            </div>
                          ) : (
                            <span className="text-muted-foreground">{r.whomToMeet}</span>
                          )}
                        </TableCell>
                        <TableCell>{r.purpose}</TableCell>
                        <TableCell>
                          {emp ? (
                            <div className="flex items-center gap-1.5">
                              <span
                                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                                  r.notifiedEmailAt
                                    ? "border-green-200 bg-green-50 text-green-700"
                                    : "border-gray-200 bg-gray-50 text-gray-400"
                                }`}
                                title={r.notifiedEmailAt ? `Emailed ${fmtDateTime(r.notifiedEmailAt)}` : "Not emailed"}
                              >
                                <Mail size={11} /> {r.notifiedEmailAt ? "Sent" : "—"}
                              </span>
                              <span
                                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                                  r.notifiedWhatsappAt
                                    ? "border-green-200 bg-green-50 text-green-700"
                                    : "border-gray-200 bg-gray-50 text-gray-400"
                                }`}
                                title={
                                  r.notifiedWhatsappAt
                                    ? `WhatsApp sent ${fmtDateTime(r.notifiedWhatsappAt)}`
                                    : "Not sent"
                                }
                              >
                                <MessageCircle size={11} /> {r.notifiedWhatsappAt ? "Sent" : "—"}
                              </span>
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>{r.branchName ?? "—"}</TableCell>
                        <TableCell className="text-muted-foreground">{fmtDateTime(r.visitedAt)}</TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
          {page_ && (
            <RecordsPagination page={page_.page} total={page_.total} pageSize={page_.pageSize} onPageChange={setPage} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
