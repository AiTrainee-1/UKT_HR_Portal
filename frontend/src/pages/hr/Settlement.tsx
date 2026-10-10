import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Download, HandCoins, Hourglass, Plus, Search, UserMinus, Wallet } from "lucide-react";
import HrLayout from "@/components/HrLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  useCreateAdvance,
  useDeleteAdvance,
  useListAdvances,
  useListEmployees,
  useUpdateAdvance,
} from "@/lib/api-client";
import AdvanceList from "./settlement/AdvanceList";
import { DecisionDialog, DeleteDialog, type Decision } from "./settlement/ConfirmDialogs";
import CreateDialog from "./settlement/CreateDialog";
import DetailSheet from "./settlement/DetailSheet";
import Toolbar from "./settlement/Toolbar";
import {
  DEFAULT_FILTERS,
  DEFAULT_SORT,
  NO_FILTERS,
  exportTable,
  filterRows,
  sortRows,
  summarize,
  type Filters,
  type Sort,
  type SortKey,
  type SettlementRow,
} from "./settlement/logic";
import { EmptyState, StatCard } from "./settlement/parts";
import { downloadTable, formatMoney } from "./settlement/shared";

/** A column opens in the direction people expect for it: A to Z, earliest first, biggest or newest first. */
const FIRST_DIRECTION: Record<SortKey, Sort["dir"]> = {
  created: "desc",
  employee: "asc",
  amount: "desc",
  outstanding: "desc",
  recovery: "desc",
  start: "asc",
  status: "asc",
};

/** Settlement: salary advances and term loans: raise one, approve it, and follow what payroll has recovered. */
export default function Settlement() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SettlementRow | null>(null);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);

  const { data: advances, isLoading, isError, refetch } = useListAdvances();
  const { data: employees } = useListEmployees({ status: "active" });
  const createMutation = useCreateAdvance();
  const updateMutation = useUpdateAdvance();
  const deleteMutation = useDeleteAdvance();

  const all = useMemo(() => (advances ?? []) as SettlementRow[], [advances]);
  const summary = useMemo(() => summarize(all), [all]);
  const shown = useMemo(() => sortRows(filterRows(all, filters), sort), [all, filters, sort]);

  const refreshLists = () => queryClient.invalidateQueries({ queryKey: ["/api/advances"] });

  const decide = async ({ row, status }: Decision) => {
    setDecision(null);
    setBusyId(row.id);
    try {
      await updateMutation.mutateAsync({ id: row.id, data: { status } });
      toast({ title: `Advance ${status}` });
      refreshLists();
      queryClient.invalidateQueries({ queryKey: ["advance-detail", row.id] });
    } catch (err) {
      toast({
        title: "Failed to update advance",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    } finally {
      setBusyId(null);
    }
  };

  const createAdvance = async (payload: Parameters<typeof createMutation.mutateAsync>[0]) => {
    await createMutation.mutateAsync(payload);
    toast({ title: "Advance created" });
    refreshLists();
    // show the new one: it starts as pending
    setFilters(DEFAULT_FILTERS);
  };

  const removeAdvance = async (row: SettlementRow) => {
    try {
      await deleteMutation.mutateAsync(row.id);
      toast({ title: "Advance deleted" });
      refreshLists();
    } catch (err) {
      toast({
        title: "Failed to delete advance",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    } finally {
      setDeleteTarget(null);
    }
  };

  const onHeadSort = (key: SortKey) =>
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: FIRST_DIRECTION[key] },
    );

  const exportList = async () => {
    try {
      await downloadTable(exportTable(shown), "Settlement_advances");
    } catch {
      toast({ title: "Could not create the export", variant: "destructive" });
    }
  };

  const statsLoading = isLoading || isError;
  const noneAtAll = !isLoading && !isError && all.length === 0;

  return (
    <HrLayout>
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-2xl font-black text-gray-900">Settlement</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">Manage general advances and term loans</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span data-view-safe>
              <Button
                variant="outline"
                className="gap-2"
                onClick={exportList}
                disabled={shown.length === 0}
                data-testid="settlement-export"
              >
                <Download size={15} /> Export
              </Button>
            </span>
            <Button className="gap-2" onClick={() => setShowCreate(true)} data-testid="new-advance">
              <Plus size={15} /> New Advance
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard
            testId="stat-pending"
            label="Pending approval"
            value={statsLoading ? "-" : summary.pendingCount}
            sub={statsLoading ? undefined : `${formatMoney(summary.pendingAmount)} requested`}
            icon={Hourglass}
            tone="bg-amber-50 text-amber-800"
          />
          <StatCard
            testId="stat-active"
            label="Active advances"
            value={statsLoading ? "-" : summary.activeCount}
            sub={statsLoading ? undefined : `${formatMoney(summary.outstanding)} still to recover`}
            icon={Wallet}
            tone="bg-blue-50 text-blue-800"
          />
          <StatCard
            testId="stat-recovered"
            label="Recovered so far"
            value={statsLoading ? "-" : formatMoney(summary.recovered)}
            sub={
              statsLoading
                ? undefined
                : `${summary.completedCount} completed · ${formatMoney(summary.monthlyEmi)}/month in term EMIs`
            }
            icon={HandCoins}
            tone="bg-green-50 text-green-800"
          />
          <StatCard
            testId="stat-left"
            label="Owed by employees who left"
            value={statsLoading ? "-" : formatMoney(summary.leftOutstanding)}
            sub={
              statsLoading
                ? undefined
                : summary.leftCount > 0
                  ? `${summary.leftCount} ${summary.leftCount === 1 ? "advance" : "advances"}: for the final settlement`
                  : "nothing outstanding"
            }
            icon={UserMinus}
            tone="bg-slate-100 text-slate-800"
          />
        </div>

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

        <Card className="overflow-hidden rounded-2xl">
          <CardContent className="p-0">
            {isLoading ? (
              <div className="space-y-3 p-4" data-testid="advances-loading">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-16 w-full rounded-xl" />
                ))}
              </div>
            ) : isError ? (
              <EmptyState
                icon={AlertTriangle}
                tone="bg-red-50 text-red-600"
                title="The advances could not be loaded"
                text="Check your connection and try again."
                testId="advances-error"
              >
                <Button variant="outline" onClick={() => refetch()}>
                  Retry
                </Button>
              </EmptyState>
            ) : noneAtAll ? (
              <EmptyState
                icon={HandCoins}
                title="No advances yet"
                text="Record a salary advance or a term loan for an employee. Once approved, payroll deducts it automatically."
                testId="advances-empty"
              >
                <Button onClick={() => setShowCreate(true)} className="gap-1.5">
                  <Plus size={15} /> Create the first advance
                </Button>
              </EmptyState>
            ) : shown.length === 0 ? (
              <EmptyState
                icon={Search}
                tone="bg-gray-100 text-gray-500"
                title="No advance matches"
                text="Try fewer words, another status, or clear the filters."
                testId="advances-no-match"
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
            ) : (
              <AdvanceList
                rows={shown}
                sort={sort}
                onSort={onHeadSort}
                onOpen={(row) => setSelectedId(row.id)}
                onApprove={(row) => setDecision({ row, status: "approved" })}
                onReject={(row) => setDecision({ row, status: "rejected" })}
                onDelete={setDeleteTarget}
                busyId={busyId}
              />
            )}
          </CardContent>
        </Card>

        <CreateDialog
          open={showCreate}
          onClose={() => setShowCreate(false)}
          employees={employees}
          onSubmit={createAdvance}
        />

        <DecisionDialog decision={decision} onConfirm={decide} onCancel={() => setDecision(null)} />

        <DeleteDialog
          row={deleteTarget}
          busy={deleteMutation.isPending}
          onConfirm={removeAdvance}
          onCancel={() => setDeleteTarget(null)}
        />

        <DetailSheet
          advanceId={selectedId}
          onClose={() => setSelectedId(null)}
          onApprove={(row) => {
            setSelectedId(null);
            setDecision({ row, status: "approved" });
          }}
          onReject={(row) => {
            setSelectedId(null);
            setDecision({ row, status: "rejected" });
          }}
          onDelete={(row) => {
            setSelectedId(null);
            setDeleteTarget(row);
          }}
        />
      </div>
    </HrLayout>
  );
}
