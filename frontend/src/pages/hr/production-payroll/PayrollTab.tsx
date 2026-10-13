import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Download,
  IndianRupee,
  Layers,
  Play,
  Search,
  TrendingUp,
  Users,
} from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ShieldLoader } from "@/components/ui/ShieldLoader";
import PayrollGenerationPipeline from "@/components/PayrollGenerationPipeline";
import { BreakdownDrawer, PayrollRow } from "@/components/payroll/BreakdownDrawer";
import { usePayrollGeneration } from "@/contexts/PayrollGenerationContext";
import { useToast } from "@/hooks/use-toast";
import { useListDepartments, useUpdatePayrollRecord } from "@/lib/api-client";
import {
  PAY_CYCLE_INFO,
  useListProductionPayroll,
  useProductionPeriodStatus,
  type CyclePeriod,
  type PayCycle,
  type ProductionPeriods,
} from "@/lib/api-client/custom-hooks";
import { exportPayrollToExcel } from "@/lib/payrollExcelExport";
import { GenerateDialog } from "./GenerateDialog";
import { SkippedDialog } from "./SkippedDialog";
import { PeriodPicker } from "./PeriodPicker";
import { filterRows, formatPeriod, rupees, totalsOf } from "./logic";

/**
 * Payroll tab of a cycle page: the period, the figures of its payslips, "Generate payroll" for the whole roster and the
 * list of payslips generated for the period (history stays reachable through the period picker).
 */
export function PayrollTab({
  cycle,
  period,
  periods,
  periodsLoading,
  onPeriodChange,
  onPickDate,
}: {
  cycle: PayCycle;
  period: CyclePeriod | null;
  periods: ProductionPeriods | undefined;
  periodsLoading: boolean;
  onPeriodChange: (period: CyclePeriod) => void;
  onPickDate: (date: string) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const info = PAY_CYCLE_INFO[cycle];
  const [showGenerate, setShowGenerate] = useState(false);
  const [showSkipped, setShowSkipped] = useState(false);
  const [breakdownId, setBreakdownId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [department, setDepartment] = useState("all");

  const updateMutation = useUpdatePayrollRecord();
  const { showPipeline, progress, dismiss: dismissPipeline } = usePayrollGeneration();
  const { data: departments } = useListDepartments();
  const status = useProductionPeriodStatus(cycle, period);
  const rowsQuery = useListProductionPayroll(
    { cycle, periodStart: period?.periodStart, periodEnd: period?.periodEnd, limit: 500 },
    { enabled: !!period },
  );

  const rows = useMemo(() => rowsQuery.data ?? [], [rowsQuery.data]);
  const shown = useMemo(() => filterRows(rows, search, department), [rows, search, department]);
  const totals = useMemo(() => totalsOf(shown), [shown]);
  const counts = status.data?.counts;
  const roster = status.data?.employees.length ?? 0;
  const done = (counts?.generated ?? 0) + (counts?.paid ?? 0);

  const refreshPayroll = () =>
    queryClient.invalidateQueries({
      predicate: (q) => typeof q.queryKey[0] === "string" && q.queryKey[0].startsWith("/api/payroll"),
    });

  const handleMarkPaid = async (run: { id: number; employeeName?: string | null }) => {
    try {
      await updateMutation.mutateAsync({ id: run.id, data: { status: "paid" } });
      toast({ title: `${run.employeeName ?? "Employee"}'s salary marked as paid` });
      void refreshPayroll();
    } catch {
      toast({ title: "Failed to update status", variant: "destructive" });
    }
  };

  const cards = [
    {
      key: "roster",
      label: `${info.label} employees`,
      value: `${roster}`,
      sub: roster === 0 ? "nobody assigned yet" : `${done} generated`,
      color: "text-indigo-700",
      icon: Users,
      bg: "bg-indigo-50",
    },
    {
      key: "gross",
      label: "Total Gross",
      value: `${rupees(totals.gross)}`,
      sub: `${shown.length} payslip${shown.length === 1 ? "" : "s"}`,
      color: "text-blue-700",
      icon: TrendingUp,
      bg: "bg-blue-50",
    },
    {
      key: "deductions",
      label: "Deductions",
      value: rupees(totals.deductions),
      color: "text-red-600",
      icon: IndianRupee,
      bg: "bg-red-50",
    },
    {
      key: "net",
      label: "Net Payable",
      value: rupees(totals.net),
      color: "text-green-700",
      icon: CheckCircle2,
      bg: "bg-green-50",
    },
    {
      key: "pending",
      label: "Pending Payment",
      value: `${totals.pendingEmployees} employee${totals.pendingEmployees === 1 ? "" : "s"}`,
      sub: rupees(totals.pendingNet),
      color: "text-amber-700",
      icon: Clock,
      bg: "bg-amber-50",
    },
    {
      key: "todo",
      label: "Not generated",
      value: `${(counts?.ready ?? 0) + (counts?.blocked ?? 0)}`,
      sub: counts?.blocked ? `${counts.blocked} cannot be generated` : "ready to generate",
      color: "text-orange-700",
      icon: AlertTriangle,
      bg: "bg-orange-50",
      onClick: () => setShowSkipped(true),
    },
  ];

  return (
    <div className="space-y-6" data-testid="pcp-payroll-tab">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PeriodPicker
          periods={periods}
          period={period}
          onChange={onPeriodChange}
          onPickDate={onPickDate}
          loading={periodsLoading}
        />
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            className="h-9 gap-2 border-amber-200 text-amber-700 hover:bg-amber-50"
            onClick={() => setShowSkipped(true)}
            disabled={!period}
            data-testid="pcp-skipped-open"
          >
            <AlertTriangle size={14} /> Skipped Employees
          </Button>
          <Button
            className="h-9 gap-2 bg-amber-600 hover:bg-amber-700"
            onClick={() => setShowGenerate(true)}
            disabled={!period || !status.data}
            data-testid="pcp-generate-open"
          >
            <Play size={14} /> Generate Payroll
          </Button>
        </div>
      </div>

      <PayrollGenerationPipeline active={showPipeline} data={progress} onDismiss={dismissPipeline} />

      {showGenerate && period && status.data && (
        <GenerateDialog
          cycle={cycle}
          period={period}
          status={status.data}
          onClose={() => setShowGenerate(false)}
          onStarted={onPeriodChange}
        />
      )}
      {showSkipped && period && (
        <SkippedDialog cycle={cycle} initial={period} periods={periods} onClose={() => setShowSkipped(false)} />
      )}

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full sm:w-72">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by employee code or name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 w-full pl-8 text-sm"
            data-testid="pcp-search"
          />
        </div>
        <Select value={department} onValueChange={setDepartment}>
          <SelectTrigger className="h-8 w-44 text-sm">
            <SelectValue placeholder="Department" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Departments</SelectItem>
            {departments?.map((d) => (
              <SelectItem key={d.id} value={String(d.id)}>
                {d.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {shown.length > 0 && period && (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto h-8 gap-2 border-green-600 text-green-700 hover:bg-green-50"
            onClick={() =>
              exportPayrollToExcel(shown, "Production", `${info.label}_${period.periodStart}_${period.periodEnd}`)
            }
          >
            <Download size={13} /> Export to Excel
          </Button>
        )}
      </div>

      {period && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6" data-testid="pcp-kpis">
          {cards.map((s) => (
            <Card
              key={s.key}
              className={`border-0 shadow-sm ${s.onClick ? "cursor-pointer transition-shadow hover:shadow-md" : ""}`}
              onClick={s.onClick}
              data-testid={`pcp-kpi-${s.key}`}
            >
              <CardContent className="flex items-center gap-3 p-4">
                <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${s.bg}`}>
                  <s.icon size={16} className={s.color} />
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">{s.label}</p>
                  <p className={`text-base font-black ${s.color}`}>{s.value}</p>
                  {s.sub && <p className="text-[10px] leading-snug text-muted-foreground">{s.sub}</p>}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <div className="space-y-2">
        {status.isError ? (
          <div
            className="rounded-xl border border-red-200 bg-red-50 px-4 py-6 text-center text-sm text-red-800"
            role="alert"
            data-testid="pcp-period-error"
          >
            {status.error instanceof Error ? status.error.message : "This period could not be loaded."} Pick another pay
            period above.
          </div>
        ) : rowsQuery.isLoading || status.isLoading ? (
          <ShieldLoader />
        ) : roster === 0 && rows.length === 0 ? (
          <div
            className="rounded-xl border-2 border-dashed border-gray-200 py-16 text-center text-muted-foreground"
            data-testid="pcp-empty-roster"
          >
            <Users size={32} className="mx-auto mb-3 text-gray-200" />
            <p className="text-sm font-semibold text-gray-600">
              No employees are assigned to the {info.label} cycle yet
            </p>
            <p className="mt-1 text-xs text-gray-400">
              Payroll is generated only for the production employees assigned to this cycle.
            </p>
            <Button asChild className="mt-4 gap-2 bg-amber-600 hover:bg-amber-700">
              <Link href="/hr/employees/productionEmployee">Open Production Employees</Link>
            </Button>
          </div>
        ) : shown.length === 0 ? (
          <div
            className="rounded-xl border-2 border-dashed border-gray-200 py-16 text-center text-muted-foreground"
            data-testid="pcp-empty-period"
          >
            <Layers size={32} className="mx-auto mb-3 text-gray-200" />
            <p className="text-sm font-semibold text-gray-600">
              {rows.length > 0 ? "No payslip matches the search" : "No payroll generated for this period yet"}
            </p>
            {rows.length === 0 && period && (
              <>
                <p className="mt-1 text-xs text-gray-400">
                  {formatPeriod(period)}: click "Generate Payroll" to compute it from attendance.
                </p>
                <Button
                  className="mt-4 gap-2 bg-amber-600 hover:bg-amber-700"
                  onClick={() => setShowGenerate(true)}
                  disabled={!status.data}
                >
                  <Play size={14} /> Generate Payroll
                </Button>
              </>
            )}
          </div>
        ) : (
          <div className="space-y-2" data-testid="pcp-rows">
            {shown.map((run) => (
              <PayrollRow key={run.id} run={run} onViewBreakdown={setBreakdownId} onMarkPaid={handleMarkPaid} />
            ))}
          </div>
        )}
      </div>

      <Card className="border-0 bg-gray-50">
        <CardContent className="p-4">
          <div className="flex items-start gap-2">
            <AlertCircle size={14} className="mt-0.5 shrink-0 text-amber-500" />
            <div className="space-y-0.5 text-xs text-gray-500">
              <p>
                <strong>{info.label}:</strong> {info.calculation.toLowerCase()}, a {info.days}-day period. Pay = total
                shifts earned × salary per shift, computed from the punch-time coverage of the shift segments set in
                Manage Shifts (Production).
              </p>
              <p>
                <strong>Who is paid here</strong> is decided on{" "}
                <Link href="/hr/employees/productionEmployee" className="underline">
                  Production Employees
                </Link>
                ; the period and the late rules of this cycle are in{" "}
                <Link href="/hr/settings?tab=production_payroll" className="underline">
                  Settings → Production Payroll
                </Link>
                .
              </p>
              <p>
                <strong>Generating again</strong> never overwrites payroll that exists: employees who already have a
                payslip for the period are left as they are (use Employees → Generate again for one pending payslip).
                Advances are auto-deducted from the monthly repayment schedule configured in the Advances module.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {breakdownId && <BreakdownDrawer payrollId={breakdownId} onClose={() => setBreakdownId(null)} />}
    </div>
  );
}
