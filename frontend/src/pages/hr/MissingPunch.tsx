import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Fingerprint,
  Hourglass,
  Info,
  ListChecks,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import HrLayout from "@/components/HrLayout";
import { PipelineNote } from "@/components/ApprovalTrail";
import { RefreshButton } from "@/components/PageRefreshBar";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { waitingText } from "@/lib/approval-workflow";
import { useMissingPunchRequestsHR, useUpdateMissingPunchHR } from "@/lib/api-client/custom-hooks";
import { EmptyState, StatCard } from "./settlement/parts";
import { downloadTable } from "./settlement/shared";
import BulkDialog from "./missing-punch/BulkDialog";
import DetailSheet from "./missing-punch/DetailSheet";
import RequestCard from "./missing-punch/RequestCard";
import Toolbar from "./missing-punch/Toolbar";
import {
  DEFAULT_FILTERS,
  DEFAULT_SORT,
  LIST_CAP,
  NO_FILTERS,
  bulkApprovable,
  exportTable,
  filterRows,
  punchLabel,
  sortRows,
  summarize,
  type Filters,
  type MissingRow,
  type Sort,
} from "./missing-punch/logic";

/** Missing Punch: forgotten punches that employees report, decided through the approval pipeline (Department Head, then HR). */
export default function MissingPunch() {
  const { toast } = useToast();
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [detailId, setDetailId] = useState<number | null>(null);
  const [bulkRows, setBulkRows] = useState<MissingRow[]>([]);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [bulkRunning, setBulkRunning] = useState(false);

  const { data: items, isLoading, isError, refetch } = useMissingPunchRequestsHR("all");
  const updateMutation = useUpdateMissingPunchHR();

  const all = useMemo(() => (items ?? []) as MissingRow[], [items]);
  const summary = useMemo(() => summarize(all), [all]);
  const shown = useMemo(() => sortRows(filterRows(all, filters), sort), [all, filters, sort]);
  const decidable = useMemo(() => bulkApprovable(shown), [shown]);
  const picked = useMemo(() => decidable.filter((r) => selected.has(r.id)), [decidable, selected]);
  const detail = useMemo(() => all.find((r) => r.id === detailId) ?? null, [all, detailId]);
  const statsLoading = isLoading || isError;
  const noneAtAll = !isLoading && !isError && all.length === 0;

  const decide = async (r: MissingRow, status: "approved" | "rejected", comment?: string) => {
    setBusyId(r.id);
    try {
      const result = await updateMutation.mutateAsync({ id: r.id, status, comment: comment || undefined });
      const passedOn = status === "approved" && result?.status !== "approved";
      toast({
        title: passedOn ? "Missing Punch approved" : `Missing Punch ${status}`,
        description: passedOn
          ? `${waitingText(result?.approval) ?? "Waiting for the next approval"}: it is added to attendance once that is done.`
          : status === "approved"
            ? `${punchLabel(r)} at ${r.punchTime} on ${r.date} has been added to ${r.employeeName}'s attendance.`
            : `${r.employeeName}'s Missing Punch request for ${r.date} was rejected.`,
      });
    } catch (err) {
      const e = err as { data?: { error?: string }; message?: string };
      toast({ title: e?.data?.error ?? e?.message ?? "Failed to update", variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const approveSelected = async () => {
    const rows = bulkRows;
    setBulkRows([]);
    setBulkRunning(true);
    let added = 0;
    let passedOn = 0;
    const failures: string[] = [];
    // one at a time: each goes through the pipeline on its own, and a refusal of one must not stop the rest
    for (const r of rows) {
      try {
        const result = await updateMutation.mutateAsync({ id: r.id, status: "approved" });
        if (result?.status === "approved") added += 1;
        else passedOn += 1;
      } catch (err) {
        const e = err as { data?: { error?: string }; message?: string };
        failures.push(`${r.employeeName} (${r.date}): ${e?.data?.error ?? e?.message ?? "failed"}`);
      }
    }
    setBulkRunning(false);
    setSelected(new Set());
    const done = [
      added > 0 ? `${added} added to attendance` : "",
      passedOn > 0 ? `${passedOn} passed on to the next approval` : "",
    ].filter(Boolean);
    toast({
      title:
        failures.length === 0
          ? `Approved ${rows.length} ${rows.length === 1 ? "request" : "requests"}`
          : `${failures.length} of ${rows.length} could not be approved`,
      description: [done.join(", "), failures.slice(0, 3).join("; ")].filter(Boolean).join(". "),
      variant: failures.length > 0 ? "destructive" : undefined,
    });
  };

  const toggle = (id: number, on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const allPicked = decidable.length > 0 && picked.length === decidable.length;

  const exportList = async () => {
    try {
      await downloadTable(exportTable(shown), "Missing_punch_requests");
    } catch {
      toast({ title: "Could not create the export", variant: "destructive" });
    }
  };

  return (
    <HrLayout>
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-2xl font-black text-gray-900">Missing Punch</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">Employee-reported forgotten punches.</p>
            <PipelineNote workflow="missing_punch" className="mt-1" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span data-view-safe>
              <Button
                variant="outline"
                className="gap-2"
                onClick={exportList}
                disabled={shown.length === 0}
                data-testid="mp-export"
              >
                <Download size={15} /> Export
              </Button>
            </span>
            <RefreshButton />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard
            testId="mp-stat-hr"
            label="Awaiting HR"
            value={statsLoading ? "-" : summary.awaitingHr}
            sub={statsLoading ? undefined : `${summary.hrCanDecide} that HR can decide now`}
            icon={ShieldCheck}
            tone="bg-blue-50 text-blue-800"
          />
          <StatCard
            testId="mp-stat-hod"
            label="Awaiting Department Head"
            value={statsLoading ? "-" : summary.awaitingHod}
            sub="HR cannot decide these yet"
            icon={Hourglass}
            tone="bg-amber-50 text-amber-800"
          />
          <StatCard
            testId="mp-stat-approved"
            label="Approved this month"
            value={statsLoading ? "-" : summary.approvedThisMonth}
            sub="added to attendance"
            icon={CheckCircle2}
            tone="bg-green-50 text-green-800"
          />
          <StatCard
            testId="mp-stat-rejected"
            label="Rejected this month"
            value={statsLoading ? "-" : summary.rejectedThisMonth}
            sub="nothing written to attendance"
            icon={XCircle}
            tone="bg-red-50 text-red-800"
          />
        </div>

        <div className="flex items-start gap-2 rounded-xl border border-blue-100 bg-blue-50 p-3 text-xs text-blue-700">
          <Info size={14} className="mt-0.5 shrink-0" />
          <span>
            Requests are submitted from the employee mobile/web app with a date, time and reason. Who approves them, and
            in what order, is set in <strong>User Management → Approval Workflow Control</strong> (shown above); a
            Department Head decides from the mobile app when "Can approve missing punch" is switched on for them in HOD
            Assignment. Once the final approval is given, the punch is written to attendance and flows through the
            normal engine (punch-order rules, punctuality window, cross-midnight logic) exactly like a real biometric
            punch.
          </span>
        </div>

        {all.length >= LIST_CAP && (
          <div
            className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"
            data-testid="mp-truncated"
          >
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <p>Only the latest {LIST_CAP} requests are loaded: older ones are not listed here.</p>
          </div>
        )}

        {!noneAtAll && (
          <Toolbar
            rows={all}
            filters={filters}
            onFilters={setFilters}
            sort={sort}
            onSort={setSort}
            shown={shown.length}
          />
        )}

        {decidable.length > 0 && (
          <div
            className="flex flex-wrap items-center gap-3 rounded-2xl border border-blue-100 bg-blue-50/60 px-4 py-2.5"
            data-testid="mp-bulk-bar"
          >
            <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-blue-900">
              <Checkbox
                checked={allPicked}
                onCheckedChange={(v) => setSelected(v === true ? new Set(decidable.map((r) => r.id)) : new Set())}
                aria-label="Select every request HR can approve"
                data-testid="mp-select-all"
              />
              {picked.length > 0
                ? `${picked.length} of ${decidable.length} selected`
                : `${decidable.length} ${decidable.length === 1 ? "request" : "requests"} HR can approve now`}
            </label>
            {picked.length > 0 && (
              <>
                <Button
                  size="sm"
                  className="ml-auto h-8 gap-1.5 bg-green-600 text-xs hover:bg-green-700"
                  disabled={bulkRunning}
                  onClick={() => setBulkRows(picked)}
                  data-testid="mp-bulk-approve"
                >
                  <ListChecks size={13} /> Approve selected ({picked.length})
                </Button>
                <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => setSelected(new Set())}>
                  Clear selection
                </Button>
              </>
            )}
          </div>
        )}

        <div className="space-y-3" data-testid="mp-list">
          {isLoading ? (
            Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-2xl" />)
          ) : isError ? (
            <Card className="rounded-2xl">
              <CardContent className="p-0">
                <EmptyState
                  icon={AlertTriangle}
                  tone="bg-red-50 text-red-600"
                  title="The requests could not be loaded"
                  text="Check your connection and try again."
                  testId="mp-error"
                >
                  <Button variant="outline" onClick={() => refetch()}>
                    Retry
                  </Button>
                </EmptyState>
              </CardContent>
            </Card>
          ) : noneAtAll ? (
            <Card className="rounded-2xl">
              <CardContent className="p-0">
                <EmptyState
                  icon={Fingerprint}
                  title="No missing punch requests yet"
                  text="When an employee reports a forgotten punch from the mobile or web app, it appears here."
                  testId="mp-empty"
                />
              </CardContent>
            </Card>
          ) : shown.length === 0 ? (
            <Card className="rounded-2xl">
              <CardContent className="p-0">
                <EmptyState
                  icon={Fingerprint}
                  tone="bg-gray-100 text-gray-500"
                  title="No request matches"
                  text="Try fewer words, another status, or clear the filters."
                  testId="mp-no-match"
                >
                  <Button
                    variant="outline"
                    onClick={() => {
                      setFilters(NO_FILTERS);
                      setSort(DEFAULT_SORT);
                    }}
                  >
                    Clear filters
                  </Button>
                </EmptyState>
              </CardContent>
            </Card>
          ) : (
            shown.map((r) => (
              <RequestCard
                key={r.id}
                r={r}
                selected={selected.has(r.id)}
                onSelect={(on) => toggle(r.id, on)}
                busy={busyId === r.id || bulkRunning}
                onApprove={(row) => decide(row, "approved")}
                onReject={(row) => decide(row, "rejected")}
                onOpen={(row) => setDetailId(row.id)}
              />
            ))
          )}
        </div>

        <BulkDialog rows={bulkRows} onConfirm={approveSelected} onCancel={() => setBulkRows([])} />

        <DetailSheet
          row={detail}
          busy={busyId !== null || bulkRunning}
          onClose={() => setDetailId(null)}
          onDecide={decide}
        />
      </div>
    </HrLayout>
  );
}
