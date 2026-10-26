import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Landmark, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CircleLoader } from "@/components/ui/CircleLoader";
import { DataPagination } from "@/components/ui/DataPagination";
import { Input } from "@/components/ui/input";
import { PillTabs } from "@/components/ui/pill-tabs";
import { StatusBadge } from "@/components/ui/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import {
  PF_ESI_CLASSES,
  useRemoveTdsEmployee,
  useTdsEmployees,
  type PfEsiClass,
  type TdsEmployeeRow,
} from "@/lib/api-client/custom-hooks";
import { LoadError } from "../org-structure/parts";
import { useDebounced } from "../production-employees/hooks";
import { AddTdsDialog, EditTdsPercentDialog } from "./TdsDialogs";
import { classLabel, formatPercent, pageOf, removeWording, serverProblem } from "./logic";

const SEARCH_DELAY_MS = 250;

/**
 * TDS - Tax Deducted at Source: the employees who have TDS deducted (a percentage of their earned pay) instead of PF/ESI.
 * Opened from the Co Emp tab's header button (address: /hr/employees?tab=coemp&view=tds). Staff and Production are kept
 * apart. An employee is added by code with the Add Employee button; each row can have its percentage edited or be removed
 * from TDS. Every change refreshes this list, the Co Emp list and the coverage numbers.
 */
export function TdsPanel({
  cls,
  onClassChange,
  onBack,
}: {
  cls: PfEsiClass;
  onClassChange: (cls: PfEsiClass) => void;
  onBack: () => void;
}) {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const debounced = useDebounced(search.trim(), SEARCH_DELAY_MS);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<TdsEmployeeRow | null>(null);
  const [removing, setRemoving] = useState<TdsEmployeeRow | null>(null);
  const remove = useRemoveTdsEmployee();

  const list = useTdsEmployees({ type: cls, search: debounced || undefined });
  const counts = list.data?.counts;
  const rows = useMemo(() => (list.data?.employees ?? []).filter((r) => r.employmentType === cls), [list.data, cls]);
  const paged = pageOf(rows, page, pageSize);
  // A new pill's list is on its way: the previous class's rows are filtered out, so say nothing rather than "none".
  const waiting = list.isLoading || (list.isPlaceholderData && rows.length === 0);

  useEffect(() => {
    setPage(1);
  }, [cls, debounced]);

  const confirmRemove = async () => {
    const target = removing;
    setRemoving(null);
    if (!target) return;
    try {
      await remove.mutateAsync({ employeeId: target.id });
      toast({
        title: `${target.employeeCode} removed from TDS`,
        description: `${target.name} now has no PF/ESI and no TDS. Turn Co Emp on to apply PF/ESI.`,
      });
    } catch (err) {
      toast({ title: "Could not remove from TDS", description: serverProblem(err).message, variant: "destructive" });
    }
  };

  const failed = list.isError && !list.data;
  const wording = removing ? removeWording(removing) : null;

  return (
    <div className="space-y-5" data-testid="tds-panel">
      <Card>
        <CardContent className="flex flex-wrap items-start justify-between gap-3 p-4">
          <div className="flex items-start gap-3">
            <Button
              size="icon"
              variant="ghost"
              onClick={onBack}
              aria-label="Back to Co Emp"
              data-testid="tds-back"
              className="mt-0.5"
            >
              <ArrowLeft size={16} />
            </Button>
            <div>
              <h3 className="flex items-center gap-2 text-lg font-black text-gray-900">
                <Landmark size={18} className="text-violet-600" /> TDS – Tax Deducted at Source
              </h3>
              <p className="mt-0.5 max-w-2xl text-sm text-muted-foreground">
                Employees here have TDS deducted from their earned pay at the percentage set for them, and never have
                PF/ESI. They stay visible in the CoPortal. Adding someone who is in Co Emp moves them out of it.
              </p>
            </div>
          </div>
          <Button onClick={() => setAdding(true)} data-testid="button-tds-add-employee">
            <Plus size={16} className="mr-2" /> Add Employee
          </Button>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div data-testid="tds-class-tabs">
          <PillTabs
            items={PF_ESI_CLASSES.map((c) => ({
              value: c,
              label: classLabel(c),
              count: counts ? counts[c] : undefined,
            }))}
            value={cls}
            onChange={(value) => onClassChange(value === "production" ? "production" : "staff")}
          />
        </div>
        <div className="relative w-full sm:w-72">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or employee code"
            aria-label="Search TDS employees"
            className="pl-9 pr-9"
            data-testid="tds-search"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              aria-label="Clear search"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 hover:text-gray-700"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {failed ? (
        <LoadError what="the TDS employees" onRetry={() => void list.refetch()} />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table data-testid="tds-table">
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Code</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead className="hidden md:table-cell">Department</TableHead>
                  <TableHead className="hidden md:table-cell">Branch</TableHead>
                  <TableHead>TDS %</TableHead>
                  <TableHead className="pr-4 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className={list.isPlaceholderData ? "opacity-60 transition-opacity" : "transition-opacity"}>
                {waiting ? (
                  <TableRow>
                    <TableCell colSpan={6} className="py-16">
                      <CircleLoader />
                    </TableCell>
                  </TableRow>
                ) : paged.rows.length > 0 ? (
                  paged.rows.map((row) => (
                    <TableRow key={row.id} data-testid={`row-tds-${row.id}`}>
                      <TableCell className="pl-4">
                        <Badge variant="outline" className="font-mono text-xs">
                          {row.employeeCode}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm font-semibold">
                        {row.name}
                        {row.status !== "active" && (
                          <StatusBadge tone="neutral" className="ml-2 text-[10px] font-semibold capitalize">
                            {row.status}
                          </StatusBadge>
                        )}
                      </TableCell>
                      <TableCell className="hidden text-sm text-muted-foreground md:table-cell">
                        {row.departmentName ?? "—"}
                      </TableCell>
                      <TableCell className="hidden text-sm text-muted-foreground md:table-cell">
                        {row.branchName ?? "—"}
                      </TableCell>
                      <TableCell className="text-sm font-semibold tabular-nums" data-testid={`tds-percent-${row.id}`}>
                        {formatPercent(row.tdsPercent)}%
                      </TableCell>
                      <TableCell className="pr-4">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label={`Edit TDS percentage for ${row.name}`}
                            title="Edit percentage"
                            onClick={() => setEditing(row)}
                            data-testid={`button-tds-edit-${row.id}`}
                          >
                            <Pencil size={14} />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="text-destructive"
                            aria-label={`Remove ${row.name} from TDS`}
                            title="Remove from TDS"
                            onClick={() => setRemoving(row)}
                            data-testid={`button-tds-remove-${row.id}`}
                          >
                            <Trash2 size={14} />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={6} className="py-12 text-center text-muted-foreground" data-testid="tds-empty">
                      {debounced
                        ? `No ${classLabel(cls).toLowerCase()} TDS employee matches “${debounced}”`
                        : `No ${classLabel(cls).toLowerCase()} employees are in TDS yet. Use Add Employee.`}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <DataPagination
        page={paged.page}
        totalPages={paged.totalPages}
        onPageChange={setPage}
        pageSize={pageSize}
        onPageSizeChange={setPageSize}
        totalItems={rows.length}
        className="rounded-lg border-t bg-card px-4 shadow-sm"
      />

      <AddTdsDialog open={adding} onOpenChange={setAdding} />
      <EditTdsPercentDialog row={editing} onClose={() => setEditing(null)} />

      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent data-testid="tds-remove-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{wording?.title}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                {wording?.lines.map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="tds-remove-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void confirmRemove()}
              className="bg-destructive text-destructive-foreground"
              data-testid="tds-remove-confirm"
            >
              Remove from TDS
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
