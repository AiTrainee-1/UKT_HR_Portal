import { useEffect, useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import {
  useTeaBreakRule,
  useUpdateTeaBreakRule,
  useTeaBreakSummary,
  useTeaBreakRecords,
  type GateRange,
  type TeaBreakFilter,
  type TeaBreakRecord,
  type TeaBreakRemark,
} from "@/lib/api-client/custom-hooks";
import { Filter, Save } from "lucide-react";
import { SubtabBar } from "@/components/ui/subtab-nav";
import { gatePagePath, subsOf } from "../routes";
import { KpiRow, RANGE_LABEL, RangeFilter, RecordsPagination, fmtDateTime } from "../shared";

// ── Tea Break tab ─────────────────────────────────────────────────────────
// A permanent per-employee QR, no approval -see backend/api/tea_break_views.py.
// Scanned at the same active GateDevices Outpass already uses (no separate
// device/login concept for this), so there's nothing to "manage" here beyond
// the allowed-break-time rule and the resulting records table.

const TEA_BREAK_PAGE_SIZE = 20;

const TEA_BREAK_REMARK_BADGE: Record<TeaBreakRemark, { label: string; cls: string }> = {
  overtime: { label: "Overtime", cls: "bg-red-50 text-red-700 border-red-200" },
  not_returned: { label: "Not Returned / Return Not Scanned", cls: "bg-red-50 text-red-700 border-red-200" },
  in_progress: { label: "Still Out", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  on_time: { label: "On Time", cls: "bg-green-50 text-green-700 border-green-200" },
};

function fmtTakenMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function TeaBreakRuleCard() {
  const { toast } = useToast();
  const { data: rule } = useTeaBreakRule();
  const updateRule = useUpdateTeaBreakRule();
  const [minutes, setMinutes] = useState("");

  useEffect(() => {
    if (rule) setMinutes(String(rule.allowedMinutes));
  }, [rule?.allowedMinutes]);

  const save = async () => {
    const parsed = Number(minutes);
    if (!Number.isFinite(parsed) || parsed < 1) {
      toast({ title: "Enter a valid number of minutes (at least 1)", variant: "destructive" });
      return;
    }
    try {
      await updateRule.mutateAsync(Math.round(parsed));
      toast({ title: "Tea Break rule saved" });
    } catch (err: any) {
      toast({ title: err?.message ?? "Could not save the rule", variant: "destructive" });
    }
  };

  return (
    <Card data-testid="tea-break-rule">
      <CardContent className="flex flex-wrap items-end justify-between gap-3 p-4">
        <div>
          <p className="font-bold text-sm">Tea Break Rule</p>
          <p className="text-xs text-muted-foreground">
            Anyone outside longer than this, once they return, is marked Overtime.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor="tea-break-allowed-minutes" className="text-xs">
              Allowed minutes
            </Label>
            <Input
              id="tea-break-allowed-minutes"
              type="number"
              min={1}
              className="w-28"
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
            />
          </div>
          <Button size="sm" className="gap-1.5" onClick={save} disabled={updateRule.isPending}>
            <Save size={14} /> {updateRule.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** Records: the Today / This Week / This Month filter and the Overtime / Not Returned toggles over the list of breaks. */
function TeaBreakRecords({
  range,
  onRange,
  filter,
  onFilter,
  page,
  setPage,
}: {
  range: GateRange;
  onRange: (range: GateRange) => void;
  filter: TeaBreakFilter;
  onFilter: (filter: Exclude<TeaBreakFilter, null>) => void;
  page: number;
  setPage: (page: number) => void;
}) {
  const { data: page_, isLoading } = useTeaBreakRecords(range, page, filter, TEA_BREAK_PAGE_SIZE);
  const rows: TeaBreakRecord[] = page_?.items ?? [];

  return (
    <div className="space-y-4" data-testid="tea-break-records">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <RangeFilter value={range} onChange={onRange} />
        <div className="flex items-center gap-2">
          <Button
            variant={filter === "overtime" ? "default" : "outline"}
            size="sm"
            className="gap-1.5"
            onClick={() => onFilter("overtime")}
          >
            <Filter size={13} /> Overtime
          </Button>
          <Button
            variant={filter === "not_returned" ? "default" : "outline"}
            size="sm"
            className="gap-1.5"
            onClick={() => onFilter("not_returned")}
          >
            <Filter size={13} /> Not Returned
          </Button>
        </div>
      </div>

      <Card data-testid="tea-break-list">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Employee Code</TableHead>
                  <TableHead>Department</TableHead>
                  <TableHead>Out Time</TableHead>
                  <TableHead>Return Time</TableHead>
                  <TableHead>Taken Time</TableHead>
                  <TableHead>Remark</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading && !page_ ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-10 text-muted-foreground">
                      Loading…
                    </TableCell>
                  </TableRow>
                ) : !rows.length ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-10 text-muted-foreground">
                      No tea breaks recorded for {RANGE_LABEL[range].toLowerCase()}.
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((r) => {
                    const badge = TEA_BREAK_REMARK_BADGE[r.remark];
                    return (
                      <TableRow key={r.id}>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Avatar className="size-7">
                              <AvatarImage src={r.employee.photoUrl ?? undefined} />
                              <AvatarFallback className="text-[10px]">{r.employee.name[0]}</AvatarFallback>
                            </Avatar>
                            <p className="font-medium">{r.employee.name}</p>
                          </div>
                        </TableCell>
                        <TableCell className="text-muted-foreground">{r.employee.employeeCode}</TableCell>
                        <TableCell className="text-muted-foreground">{r.employee.department ?? "—"}</TableCell>
                        <TableCell className="text-muted-foreground">{fmtDateTime(r.outAt)}</TableCell>
                        <TableCell className="text-muted-foreground">{r.inAt ? fmtDateTime(r.inAt) : "—"}</TableCell>
                        <TableCell className="tabular-nums">{fmtTakenMinutes(r.takenMinutes)}</TableCell>
                        <TableCell>
                          <Badge className={`text-xs border ${badge.cls}`}>{badge.label}</Badge>
                        </TableCell>
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

/**
 * The Tea Break page: the headline tiles above, then two subtabs with an address each: Records (the list, with its range and
 * Overtime / Not Returned filters) and Rule (the allowed minutes). The filters live here, above the panels, so they are
 * still set when you come back from the Rule tab.
 */
export function TeaBreakTab({ sub }: { sub: string }) {
  const [range, setRange] = useState<GateRange>("today");
  const [filter, setFilter] = useState<TeaBreakFilter>(null);
  const [page, setPage] = useState(1);

  const { data: summary, isLoading: summaryLoading } = useTeaBreakSummary();

  const changeRange = (v: GateRange) => {
    setRange(v);
    setPage(1);
  };
  const toggleFilter = (key: Exclude<TeaBreakFilter, null>) => {
    setFilter((f) => (f === key ? null : key));
    setPage(1);
  };

  return (
    <div className="space-y-4" data-testid="tea-break-tab">
      <KpiRow summary={summary} isLoading={summaryLoading} />

      <SubtabBar
        base={gatePagePath("tea-break")}
        value={sub}
        testId="tea-break-subtabs"
        items={[...subsOf("tea-break")]}
      />

      {sub === "rule" ? (
        <TeaBreakRuleCard />
      ) : (
        <TeaBreakRecords
          range={range}
          onRange={changeRange}
          filter={filter}
          onFilter={toggleFilter}
          page={page}
          setPage={setPage}
        />
      )}
    </div>
  );
}
