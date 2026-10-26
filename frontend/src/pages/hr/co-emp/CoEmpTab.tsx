import { useEffect, useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
import { CircleLoader } from "@/components/ui/CircleLoader";
import { DataPagination } from "@/components/ui/DataPagination";
import { PillTabs } from "@/components/ui/pill-tabs";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import {
  PF_ESI_CLASSES,
  downloadCoverageFile,
  useEmployeeCount,
  useListEmployeesPaginated,
  usePfEsiCoverage,
  useUpdateEmployeeCoEmp,
  type CoverageFileFormat,
  type PfEsiClass,
} from "@/lib/api-client/custom-hooks";
import type { Employee } from "@/lib/api-client";
import { LoadError } from "../org-structure/parts";
import { CoverageStrip } from "./CoverageStrip";
import {
  TDS_CONFIRM_TEXT,
  classLabel,
  coEmpListParams,
  coverageById,
  pfEsiHint,
  serverProblem,
  stripRows,
  toggleNeedsConfirm,
  toggleToast,
  type CoEmpFilters,
} from "./logic";

/**
 * The Co Emp tab of Employees: who PF/ESI can apply to. Staff and Production are kept apart (one pill each, each listing only
 * its own class); the table holds only what is needed to decide the switch, and has no actions column (no view, edit,
 * inactive or delete here: those stay on the Staff and Production tabs). The strip above it says how many employees have
 * PF/ESI and how many do not.
 */
export function CoEmpTab({
  cls,
  onClassChange,
  filters,
}: {
  cls: PfEsiClass;
  onClassChange: (cls: PfEsiClass) => void;
  filters: CoEmpFilters;
}) {
  const { toast } = useToast();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [pendingId, setPendingId] = useState<number | null>(null);
  const [confirming, setConfirming] = useState<Employee | null>(null);
  const [downloading, setDownloading] = useState<CoverageFileFormat | null>(null);
  const coEmpMutation = useUpdateEmployeeCoEmp();

  // Any filter (or the class) changing makes "page 3" mean something else, so the list starts again from page 1.
  useEffect(() => {
    setPage(1);
  }, [cls, filters.departmentId, filters.branchId, filters.status, filters.search]);

  const list = useListEmployeesPaginated(coEmpListParams(filters, cls, page, pageSize));
  // The server filters by class; filtering again keeps the previous class's rows off the screen while a new pill loads.
  const rows = useMemo(() => (list.data?.results ?? []).filter((e) => e.employmentType === cls), [list.data, cls]);
  const waiting = list.isLoading || (list.isPlaceholderData && rows.length === 0);
  const total = list.data?.count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  // The pills' numbers: how many employees of each class the current filters leave (only a number is fetched).
  const staffCount = useEmployeeCount({ ...filters, employmentType: "staff" });
  const productionCount = useEmployeeCount({ ...filters, employmentType: "production" });
  const counts: Record<PfEsiClass, number | undefined> = { staff: staffCount.data, production: productionCount.data };

  const coverage = usePfEsiCoverage({ type: "all", branchId: filters.branchId });
  // What each shown employee's next payroll would do (PF, ESI, both, neither). Only the class on screen is asked for.
  const detail = usePfEsiCoverage({ type: cls, branchId: filters.branchId, detail: true });
  const verdicts = useMemo(() => coverageById(detail.data?.employees), [detail.data]);
  const strip = useMemo(() => stripRows(coverage.data), [coverage.data]);

  const apply = async (emp: Employee, turnOn: boolean) => {
    setPendingId(emp.id);
    try {
      await coEmpMutation.mutateAsync({ employeeId: emp.id, enabled: turnOn });
      toast(toggleToast(emp, turnOn));
    } catch (err) {
      toast({ title: "Could not update Co Emp", description: serverProblem(err).message, variant: "destructive" });
    } finally {
      setPendingId(null);
    }
  };

  const onToggle = (emp: Employee) => {
    const turnOn = !emp.coEmpEnabled;
    if (toggleNeedsConfirm(emp, turnOn)) setConfirming(emp);
    else void apply(emp, turnOn);
  };

  const download = async (format: CoverageFileFormat) => {
    setDownloading(format);
    try {
      const filename = await downloadCoverageFile({ format, type: "all", branchId: filters.branchId });
      toast({ title: `${format === "pdf" ? "PDF" : "Excel"} downloaded`, description: filename });
    } catch (err) {
      toast({
        title: `Could not download the ${format === "pdf" ? "PDF" : "Excel"} file`,
        description: err instanceof Error ? err.message : "Something went wrong while building the file.",
        variant: "destructive",
      });
    } finally {
      setDownloading(null);
    }
  };

  const failed = list.isError && !list.data;

  return (
    <div className="space-y-5" data-testid="coemp-tab">
      <CoverageStrip
        rows={strip}
        loading={coverage.isLoading}
        failed={coverage.isError}
        onRetry={() => void coverage.refetch()}
        selected={cls}
        onSelect={onClassChange}
        onDownload={(format) => void download(format)}
        downloading={downloading}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div data-testid="coemp-class-tabs">
          <PillTabs
            items={PF_ESI_CLASSES.map((c) => ({ value: c, label: classLabel(c), count: counts[c] }))}
            value={cls}
            onChange={(value) => onClassChange(value === "production" ? "production" : "staff")}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Switch Co Emp on for an employee to apply PF/ESI to them. Employees in TDS are managed with the TDS button.
        </p>
      </div>

      {failed ? (
        <LoadError what="the employees" onRetry={() => void list.refetch()} />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table data-testid="coemp-table">
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Code</TableHead>
                  <TableHead>Unit Code</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead className="hidden md:table-cell">Department</TableHead>
                  <TableHead className="hidden md:table-cell">Branch</TableHead>
                  <TableHead className="hidden lg:table-cell">Phone</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>PF/ESI status</TableHead>
                  <TableHead className="pr-4">Co Emp</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className={list.isPlaceholderData ? "opacity-60 transition-opacity" : "transition-opacity"}>
                {waiting ? (
                  <TableRow>
                    <TableCell colSpan={9} className="py-16">
                      <CircleLoader />
                    </TableCell>
                  </TableRow>
                ) : rows.length > 0 ? (
                  rows.map((emp) => {
                    const hint = pfEsiHint(emp, verdicts.get(emp.id));
                    const name = `${emp.firstName} ${emp.lastName}`.trim();
                    return (
                      <TableRow key={emp.id} data-testid={`row-employee-${emp.id}`}>
                        <TableCell className="pl-4">
                          <Badge variant="outline" className="font-mono text-xs">
                            {emp.employeeCode}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {emp.unitCode ? (
                            <span
                              className="rounded border border-teal-200 bg-teal-50 px-2 py-1 font-mono text-xs font-bold text-teal-700"
                              title={emp.branchName ?? undefined}
                            >
                              {emp.unitCode}
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-sm font-semibold">{name}</TableCell>
                        <TableCell className="hidden text-sm text-muted-foreground md:table-cell">
                          {emp.departmentName ?? "—"}
                        </TableCell>
                        <TableCell className="hidden text-sm text-muted-foreground md:table-cell">
                          {emp.branchName ?? "—"}
                        </TableCell>
                        <TableCell className="hidden text-sm text-muted-foreground lg:table-cell">
                          {emp.phone || "—"}
                        </TableCell>
                        <TableCell>
                          <StatusBadge
                            tone={emp.status === "active" ? "success" : "neutral"}
                            className="text-xs font-semibold capitalize"
                          >
                            {emp.status}
                          </StatusBadge>
                        </TableCell>
                        <TableCell data-testid={`coemp-hint-${emp.id}`}>
                          <StatusBadge tone={hint.tone} className="text-xs font-semibold">
                            {hint.text}
                          </StatusBadge>
                          {hint.detail && <p className="mt-0.5 text-[11px] text-muted-foreground">{hint.detail}</p>}
                        </TableCell>
                        <TableCell className="pr-4">
                          <Switch
                            checked={emp.coEmpEnabled ?? false}
                            disabled={pendingId === emp.id}
                            onCheckedChange={() => onToggle(emp)}
                            aria-label={`Toggle Co Emp for ${name}`}
                            data-testid={`switch-coemp-${emp.id}`}
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })
                ) : (
                  <TableRow>
                    <TableCell colSpan={9} className="py-12 text-center text-muted-foreground">
                      No {classLabel(cls).toLowerCase()} employees found
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <DataPagination
        page={page}
        totalPages={totalPages}
        onPageChange={setPage}
        pageSize={pageSize}
        onPageSizeChange={setPageSize}
        totalItems={total}
        className="rounded-lg border-t bg-card px-4 shadow-sm"
      />

      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent data-testid="coemp-confirm-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Move out of TDS?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>{TDS_CONFIRM_TEXT}</p>
                {confirming && (
                  <p className="font-medium text-foreground">
                    {confirming.employeeCode} · {confirming.firstName} {confirming.lastName}
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="coemp-confirm-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const target = confirming;
                setConfirming(null);
                if (target) void apply(target, true);
              }}
              data-testid="coemp-confirm"
            >
              Turn Co Emp on
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
