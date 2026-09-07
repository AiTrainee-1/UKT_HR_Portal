import { useMemo, useState } from "react";
import ExcelJS from "exceljs";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CircleLoader } from "@/components/ui/CircleLoader";
import { useToast } from "@/hooks/use-toast";
import { useListDepartments, useSearchEmployees } from "@/lib/api-client";
import {
  useListBranches, getListBranchesQueryKey, useCompensation, type CompensationRow,
  useOvertimeList, useAnnounceOvertime, useRejectOvertime,
  useCompensationCredits, useRedeemCompensationCredit,
  useCompensationLeaveDays, useCreateCompensationLeaveDay, useDeleteCompensationLeaveDay,
  type CompensationLeaveDayRow,
  useCompensationSummary, type CompensationBenefitRow,
  usePayrollSettings,
} from "@/lib/api-client/custom-hooks";
import { useAuth } from "@/contexts/AuthContext";
import { Search, Download, Landmark, Clock, CalendarPlus, History, X, Trash2 } from "lucide-react";

const fmt = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

async function exportCompensation(rows: CompensationRow[]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Compensation");

  const columns = [
    { key: "employeeCode", label: "Code", width: 14 },
    { key: "employeeName", label: "Name", width: 22 },
    { key: "department", label: "Department", width: 18 },
    { key: "employmentType", label: "Type", width: 12 },
    { key: "basic", label: "Basic", width: 14 },
    { key: "hra", label: "HRA", width: 14 },
    { key: "allowances", label: "Allowances", width: 14 },
    { key: "employerPf", label: "Employer PF", width: 14 },
    { key: "employerEsi", label: "Employer ESI", width: 14 },
    { key: "grossMonthly", label: "Gross Monthly", width: 16 },
    { key: "annualCtc", label: "Annual CTC", width: 16 },
  ] as const;
  const currencyKeys = new Set(["basic", "hra", "allowances", "employerPf", "employerEsi", "grossMonthly", "annualCtc"]);

  ws.columns = columns.map(c => ({ key: c.key, width: c.width }));
  const headerRow = ws.getRow(1);
  columns.forEach((col, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = col.label.toUpperCase();
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF006496" } };
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.alignment = { horizontal: "center", vertical: "middle" };
  });
  headerRow.height = 22;

  (rows ?? []).forEach((row, ri) => {
    const wsRow = ws.getRow(ri + 2);
    columns.forEach((col, ci) => {
      const cell = wsRow.getCell(ci + 1);
      const raw = (row as any)[col.key];
      if (currencyKeys.has(col.key)) {
        cell.value = raw !== null && raw !== undefined ? Number(raw) : null;
        cell.numFmt = "₹#,##0.00";
      } else {
        cell.value = raw ?? "";
      }
      cell.alignment = { horizontal: "center", vertical: "middle" };
    });
  });

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `compensation-${Date.now()}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function Compensation() {
  const { user } = useAuth();
  const isBranchScoped = !!user?.branchId;
  const [tab, setTab] = useState<"ctc" | "ot" | "leave" | "history">("ctc");
  const { data: payrollSettingsData } = usePayrollSettings();
  // Treat "not loaded yet" as enabled so the page doesn't flash a disabled
  // message before Settings has even come back -same convention as the
  // sidebar's own gate on this same flag.
  const featureDisabled = payrollSettingsData?.compensationFeatureEnabled === false;

  return (
    <HrLayout>
      <div className="space-y-5">
        <div>
          <h2 className="text-2xl font-black flex items-center gap-2">
            <Landmark size={20} className="text-teal-600" /> Compensation
          </h2>
          <p className="text-muted-foreground text-sm mt-0.5">
            CTC breakdown, OT detection &amp; announcement, and Compensation-Leave days -all HR-controlled.
          </p>
        </div>

        {featureDisabled ? (
          <Card className="border-dashed">
            <CardContent className="py-16 text-center space-y-2">
              <Landmark size={32} className="mx-auto text-muted-foreground" />
              <p className="font-semibold text-gray-700">Compensation feature is currently disabled</p>
              <p className="text-sm text-muted-foreground max-w-md mx-auto">
                An HR admin turned this off in Settings → Payroll → OT / Compensation. Turn it back on there to
                use CTC Breakdown, OT Detection, Compensation Leave, and History &amp; Reports again -nothing
                has been deleted while it's off.
              </p>
            </CardContent>
          </Card>
        ) : (
          <>
            <PillTabs
              items={[
                { value: "ctc", label: "CTC Breakdown", icon: <Landmark size={13} /> },
                { value: "ot", label: "OT Detection", icon: <Clock size={13} /> },
                { value: "leave", label: "Compensation Leave", icon: <CalendarPlus size={13} /> },
                { value: "history", label: "History & Reports", icon: <History size={13} /> },
              ]}
              value={tab}
              onChange={(v) => setTab(v as any)}
              baseColor="#0f172a"
              pillBg="#f1f5f9"
            />

            {tab === "ctc" && <CtcBreakdownTab isBranchScoped={isBranchScoped} />}
            {tab === "ot" && <OvertimeTab />}
            {tab === "leave" && <CompensationLeaveTab isBranchScoped={isBranchScoped} />}
            {tab === "history" && <HistoryTab />}
          </>
        )}
      </div>
    </HrLayout>
  );
}

// ── CTC Breakdown (existing feature, unchanged content) ─────────────────────

function CtcBreakdownTab({ isBranchScoped }: { isBranchScoped: boolean }) {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [deptFilter, setDeptFilter] = useState("all");
  const [branchFilter, setBranchFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");

  useMemo(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const { data: departments } = useListDepartments();
  const { data: branches } = useListBranches({ enabled: !isBranchScoped, queryKey: getListBranchesQueryKey() });

  const { data, isLoading } = useCompensation({
    departmentId: deptFilter !== "all" ? Number(deptFilter) : undefined,
    branchId: !isBranchScoped && branchFilter !== "all" ? Number(branchFilter) : undefined,
    employmentType: typeFilter !== "all" ? typeFilter : undefined,
    search: debouncedSearch || undefined,
  });
  const rows = data?.results ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {data?.count ?? 0} employee{(data?.count ?? 0) !== 1 ? "s" : ""} · HRA/Basic split configurable in Settings → Payroll
        </p>
        <Button variant="outline" onClick={() => exportCompensation(rows)} disabled={rows.length === 0}>
          <Download size={16} className="mr-2" /> Export to Excel
        </Button>
      </div>

      <Card>
        <CardContent className="p-4 flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="Search by name, code..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Select value={deptFilter} onValueChange={setDeptFilter}>
            <SelectTrigger className="w-full sm:w-44">
              <SelectValue placeholder="Department" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Departments</SelectItem>
              {departments?.map((d) => (
                <SelectItem key={d.id} value={String(d.id)}>{d.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!isBranchScoped && (
            <Select value={branchFilter} onValueChange={setBranchFilter}>
              <SelectTrigger className="w-full sm:w-44">
                <SelectValue placeholder="Branch" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Branches</SelectItem>
                {branches?.map((b) => (
                  <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="w-full sm:w-40">
              <SelectValue placeholder="Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              <SelectItem value="staff">Staff</SelectItem>
              <SelectItem value="production">Production</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Department</TableHead>
                <TableHead>Designation</TableHead>
                <TableHead className="text-right">Basic</TableHead>
                <TableHead className="text-right">HRA</TableHead>
                <TableHead className="text-right">Allowances</TableHead>
                <TableHead className="text-right">Employer PF</TableHead>
                <TableHead className="text-right">Employer ESI</TableHead>
                <TableHead className="text-right">Gross Monthly</TableHead>
                <TableHead className="pr-4 text-right">Annual CTC</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={11} className="py-16">
                    <CircleLoader />
                  </TableCell>
                </TableRow>
              ) : rows.length > 0 ? (
                rows.map((r) => (
                  <TableRow key={r.employeeId}>
                    <TableCell className="pl-4 font-mono text-xs">{r.employeeCode}</TableCell>
                    <TableCell className="font-semibold text-sm">{r.employeeName}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{r.department ?? "—"}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{r.designation ?? "—"}</TableCell>
                    <TableCell className="text-right text-sm">{fmt(r.basic)}</TableCell>
                    <TableCell className="text-right text-sm">{fmt(r.hra)}</TableCell>
                    <TableCell className="text-right text-sm">{fmt(r.allowances)}</TableCell>
                    <TableCell className="text-right text-sm">{fmt(r.employerPf)}</TableCell>
                    <TableCell className="text-right text-sm">{fmt(r.employerEsi)}</TableCell>
                    <TableCell className="text-right text-sm font-semibold">{fmt(r.grossMonthly)}</TableCell>
                    <TableCell className="pr-4 text-right text-sm font-bold text-teal-700">{fmt(r.annualCtc)}</TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={11} className="text-center py-12 text-muted-foreground">No employees found</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

// ── OT Detection & Announce ──────────────────────────────────────────────────

function OvertimeTab() {
  const { toast } = useToast();
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [statusFilter, setStatusFilter] = useState<string>("detected");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const { data, isLoading } = useOvertimeList(month, year, statusFilter === "all" ? undefined : statusFilter);
  const announceMutation = useAnnounceOvertime();
  const rejectMutation = useRejectOvertime();

  const rows = data?.results ?? [];
  const rowKey = (r: { employeeId: number; date: string }) => `${r.employeeId}|${r.date}`;

  const toggle = (key: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const selectedRecords = rows
    .filter((r) => selected.has(rowKey(r)))
    .map((r) => ({ employeeId: r.employeeId, date: r.date }));

  const announce = async (compensationType: "pay" | "relaxation") => {
    if (selectedRecords.length === 0) return;
    try {
      const res = await announceMutation.mutateAsync({ records: selectedRecords, compensationType });
      toast({ title: `Announced ${res.announced} record(s) as ${compensationType === "pay" ? "Pay" : "Relaxation"}` });
      setSelected(new Set());
    } catch {
      toast({ title: "Failed to announce", variant: "destructive" });
    }
  };

  const reject = async () => {
    if (selectedRecords.length === 0) return;
    try {
      const res = await rejectMutation.mutateAsync({ records: selectedRecords });
      toast({ title: `Rejected ${res.rejected} record(s)` });
      setSelected(new Set());
    } catch {
      toast({ title: "Failed to reject", variant: "destructive" });
    }
  };

  return (
    <div className="space-y-4">
      {data?.settings && !data.settings.otDetectionEnabled && (
        <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800">
          OT detection is currently <strong>off</strong>. Enable it in Settings → Payroll → OT / Compensation to
          start flagging employees who work beyond their shift end.
        </div>
      )}

      <Card>
        <CardContent className="p-4 flex flex-wrap items-center gap-3">
          <Select value={String(month)} onValueChange={(v) => setMonth(Number(v))}>
            <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              {MONTH_NAMES.map((m, i) => <SelectItem key={i} value={String(i + 1)}>{m}</SelectItem>)}
            </SelectContent>
          </Select>
          <Input
            type="number" className="w-28" value={year}
            onChange={(e) => setYear(Number(e.target.value) || year)}
          />
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="detected">Detected (pending)</SelectItem>
              <SelectItem value="announced">Announced</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
              <SelectItem value="all">All</SelectItem>
            </SelectContent>
          </Select>

          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{selected.size} selected</span>
            <Button
              size="sm" variant="outline" disabled={selected.size === 0 || announceMutation.isPending}
              onClick={() => announce("pay")}
            >
              Announce as Pay
            </Button>
            <Button
              size="sm" variant="outline" disabled={selected.size === 0 || announceMutation.isPending}
              onClick={() => announce("relaxation")}
            >
              Announce as Relaxation
            </Button>
            <Button
              size="sm" variant="ghost" className="text-rose-600" disabled={selected.size === 0 || rejectMutation.isPending}
              onClick={reject}
            >
              Reject
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8 pl-4"></TableHead>
                <TableHead>Employee</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Shift End</TableHead>
                <TableHead>Last Punch</TableHead>
                <TableHead className="text-right">OT (min)</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="pr-4">Type</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={8} className="py-16"><CircleLoader /></TableCell></TableRow>
              ) : rows.length > 0 ? (
                rows.map((r) => (
                  <TableRow key={rowKey(r)}>
                    <TableCell className="pl-4">
                      {r.status === "detected" && (
                        <Checkbox checked={selected.has(rowKey(r))} onCheckedChange={() => toggle(rowKey(r))} />
                      )}
                    </TableCell>
                    <TableCell>
                      <p className="font-semibold text-sm">{r.employeeName}</p>
                      <p className="text-[11px] text-muted-foreground font-mono">{r.employeeCode}</p>
                    </TableCell>
                    <TableCell className="text-sm">{r.date}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{r.shiftEndTime ?? "—"}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{r.lastPunchOut ?? "—"}</TableCell>
                    <TableCell className="text-right text-sm font-bold text-amber-700">{r.otMinutes}</TableCell>
                    <TableCell>
                      <Badge variant={r.status === "announced" ? "default" : r.status === "rejected" ? "secondary" : "outline"}>
                        {r.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="pr-4 text-sm capitalize">{r.compensationType ?? "—"}</TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow><TableCell colSpan={8} className="text-center py-12 text-muted-foreground">No OT records for this month</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Compensation Leave (HR-announced days) ───────────────────────────────────

function CompensationLeaveTab({ isBranchScoped }: { isBranchScoped: boolean }) {
  const { toast } = useToast();
  const [date, setDate] = useState("");
  const [leaveUntil, setLeaveUntil] = useState("");
  const [reason, setReason] = useState("");
  const [empQuery, setEmpQuery] = useState("");
  const [selectedEmployees, setSelectedEmployees] = useState<{ id: number; label: string }[]>([]);

  const { data: departments } = useListDepartments();
  const { data: branches } = useListBranches({ enabled: !isBranchScoped, queryKey: getListBranchesQueryKey() });
  const [deptId, setDeptId] = useState<string>("");
  const [branchId, setBranchId] = useState<string>("");

  const { data: searchResults } = useSearchEmployees(empQuery);
  const { data: leaveDays, isLoading } = useCompensationLeaveDays({});
  const createMutation = useCreateCompensationLeaveDay();
  const deleteMutation = useDeleteCompensationLeaveDay();

  const addEmployee = (id: number, label: string) => {
    if (!selectedEmployees.some((e) => e.id === id)) {
      setSelectedEmployees((s) => [...s, { id, label }]);
    }
    setEmpQuery("");
  };

  const submit = async () => {
    if (!date) {
      toast({ title: "Date is required", variant: "destructive" });
      return;
    }
    try {
      await createMutation.mutateAsync({
        date,
        leaveUntilTime: leaveUntil || null,
        branchId: branchId ? Number(branchId) : null,
        departmentId: deptId ? Number(deptId) : null,
        employeeIds: selectedEmployees.map((e) => e.id),
        reason: reason || undefined,
      });
      toast({ title: "Compensation Day announced" });
      setDate(""); setLeaveUntil(""); setReason(""); setSelectedEmployees([]); setDeptId(""); setBranchId("");
    } catch {
      toast({ title: "Failed to announce Compensation Day", variant: "destructive" });
    }
  };

  const remove = async (id: number) => {
    try {
      await deleteMutation.mutateAsync(id);
      toast({ title: "Announcement removed" });
    } catch {
      toast({ title: "Could not remove -it may already be in the past", variant: "destructive" });
    }
  };

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="grid lg:grid-cols-2 gap-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-bold flex items-center gap-2">
            <CalendarPlus size={15} className="text-teal-600" /> Announce a Compensation Day
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">
            For festival/special days. Actual worked time still decides Full Day vs Half Shift -a compensation
            day never auto-grants Full Day. Leave "Leave Until" blank to exempt the whole day from Late/Permission
            penalties without changing the shift end used for Full/Half.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium">Date</label>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium">Leave Until (optional)</label>
              <Input type="time" value={leaveUntil} onChange={(e) => setLeaveUntil(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium">Department (optional)</label>
              <Select value={deptId || "none"} onValueChange={(v) => setDeptId(v === "none" ? "" : v)}>
                <SelectTrigger><SelectValue placeholder="Any" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Any</SelectItem>
                  {departments?.map((d) => <SelectItem key={d.id} value={String(d.id)}>{d.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {!isBranchScoped && (
              <div className="space-y-1.5">
                <label className="text-xs font-medium">Branch (optional)</label>
                <Select value={branchId || "none"} onValueChange={(v) => setBranchId(v === "none" ? "" : v)}>
                  <SelectTrigger><SelectValue placeholder="Any" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Any</SelectItem>
                    {branches?.map((b) => <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium">Specific employees (optional -leave empty to use Department/Branch above)</label>
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input className="pl-9" placeholder="Search employee name or code…" value={empQuery} onChange={(e) => setEmpQuery(e.target.value)} />
            </div>
            {empQuery.trim().length >= 2 && (searchResults?.length ?? 0) > 0 && (
              <div className="border rounded-lg divide-y max-h-40 overflow-y-auto">
                {searchResults!.map((e: any) => (
                  <button
                    key={e.id} type="button"
                    className="w-full text-left px-3 py-2 text-xs hover:bg-slate-50"
                    onClick={() => addEmployee(e.id, `${e.firstName} ${e.lastName} (${e.employeeCode})`)}
                  >
                    {e.firstName} {e.lastName} <span className="text-muted-foreground font-mono">{e.employeeCode}</span>
                  </button>
                ))}
              </div>
            )}
            {selectedEmployees.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {selectedEmployees.map((e) => (
                  <Badge key={e.id} variant="secondary" className="gap-1">
                    {e.label}
                    <button onClick={() => setSelectedEmployees((s) => s.filter((x) => x.id !== e.id))}>
                      <X size={11} />
                    </button>
                  </Badge>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium">Reason</label>
            <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Diwali half-day" />
          </div>

          <Button onClick={submit} disabled={createMutation.isPending}>
            {createMutation.isPending ? "Announcing…" : "Announce Compensation Day"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-bold">Announced Compensation Days</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {isLoading ? (
            <CircleLoader />
          ) : (leaveDays?.results ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">No Compensation Days announced yet.</p>
          ) : (
            leaveDays!.results.map((a) => (
              <div key={a.id} className="flex items-center justify-between gap-3 rounded-lg border p-3">
                <div>
                  <p className="text-sm font-semibold">{a.date} {a.leaveUntilTime ? `· Leave until ${a.leaveUntilTime}` : "· Full day exemption"}</p>
                  <p className="text-xs text-muted-foreground">
                    {a.employeeCount > 0 ? `${a.employeeCount} employee(s)` : [a.branch, a.department].filter(Boolean).join(" · ") || "All employees"}
                    {a.reason ? ` · ${a.reason}` : ""}
                  </p>
                </div>
                {a.date > today && (
                  <Button size="icon" variant="ghost" className="text-rose-600" onClick={() => remove(a.id)}>
                    <Trash2 size={14} />
                  </Button>
                )}
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── History & Reports ────────────────────────────────────────────────────────

async function exportCompensationHistory(
  month: number, year: number,
  benefiting: CompensationBenefitRow[], notBenefiting: CompensationBenefitRow[],
  leaveDays: CompensationLeaveDayRow[],
) {
  const wb = new ExcelJS.Workbook();

  const addSheet = (name: string, rows: CompensationBenefitRow[]) => {
    const ws = wb.addWorksheet(name);
    ws.columns = [
      { header: "Code", key: "employeeCode", width: 14 },
      { header: "Name", key: "employeeName", width: 22 },
      { header: "Type", key: "type", width: 12 },
      { header: "Date", key: "date", width: 14 },
      { header: "Detail", key: "detail", width: 40 },
    ];
    ws.getRow(1).font = { bold: true };
    rows.forEach((r) => ws.addRow(r));
  };
  addSheet("Benefiting", benefiting);
  addSheet("Not Benefiting", notBenefiting);

  const leaveWs = wb.addWorksheet("Compensation Leave Days");
  leaveWs.columns = [
    { header: "Date", key: "date", width: 14 },
    { header: "Leave Until", key: "leaveUntilTime", width: 14 },
    { header: "Employees", key: "employeeCount", width: 12 },
    { header: "Branch", key: "branch", width: 16 },
    { header: "Department", key: "department", width: 16 },
    { header: "Reason", key: "reason", width: 30 },
  ];
  leaveWs.getRow(1).font = { bold: true };
  leaveDays.forEach((a) => leaveWs.addRow(a));

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `compensation-history-${year}-${String(month).padStart(2, "0")}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}

function HistoryTab() {
  const { toast } = useToast();
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());

  const { data: ot } = useOvertimeList(month, year, "announced");
  const { data: credits } = useCompensationCredits();
  const { data: leaveDays } = useCompensationLeaveDays({ month, year });
  const { data: summary, isLoading: summaryLoading } = useCompensationSummary(month, year);
  const redeemMutation = useRedeemCompensationCredit();

  const otRows = ot?.results ?? [];
  const payDays = otRows.filter((r) => r.compensationType === "pay").length;
  const relaxationDays = otRows.filter((r) => r.compensationType === "relaxation").length;
  const availableCredits = (credits?.results ?? []).filter((c) => c.status === "available");
  const benefiting = summary?.benefiting ?? [];
  const notBenefiting = summary?.notBenefiting ?? [];

  const redeem = async (id: number) => {
    const date = window.prompt("Redeem this Alternative Day against which date? (YYYY-MM-DD)");
    if (!date) return;
    try {
      await redeemMutation.mutateAsync({ id, date });
      toast({ title: "Alternative Day redeemed" });
    } catch {
      toast({ title: "Failed to redeem", variant: "destructive" });
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Select value={String(month)} onValueChange={(v) => setMonth(Number(v))}>
            <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              {MONTH_NAMES.map((m, i) => <SelectItem key={i} value={String(i + 1)}>{m}</SelectItem>)}
            </SelectContent>
          </Select>
          <Input type="number" className="w-28" value={year} onChange={(e) => setYear(Number(e.target.value) || year)} />
        </div>
        <Button
          variant="outline"
          onClick={() => exportCompensationHistory(month, year, benefiting, notBenefiting, leaveDays?.results ?? [])}
        >
          <Download size={16} className="mr-2" /> Export to Excel
        </Button>
      </div>

      <div className="grid sm:grid-cols-2 gap-3">
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Paid OT cost this month (from generated payroll)</p>
          <p className="text-2xl font-black text-teal-700">{summaryLoading ? "…" : fmt(summary?.paidCost ?? 0)}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Pending OT cost (estimate -not yet paid)</p>
          <p className="text-2xl font-black text-amber-700">{summaryLoading ? "…" : fmt(summary?.pendingCostEstimate ?? 0)}</p>
        </CardContent></Card>
      </div>

      <div className="grid sm:grid-cols-3 gap-3">
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Announced Pay compensation days</p>
          <p className="text-2xl font-black text-teal-700">{payDays}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Announced Relaxation days</p>
          <p className="text-2xl font-black text-indigo-700">{relaxationDays}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Compensation Days announced this month</p>
          <p className="text-2xl font-black text-amber-700">{leaveDays?.count ?? 0}</p>
        </CardContent></Card>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-bold text-emerald-700">Employees Benefiting</CardTitle>
          </CardHeader>
          <CardContent className="p-0 overflow-x-auto">
            <BenefitTable rows={benefiting} empty="No one has benefited yet this month" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-bold text-amber-700">Employees Not Yet Benefiting</CardTitle>
          </CardHeader>
          <CardContent className="p-0 overflow-x-auto">
            <BenefitTable rows={notBenefiting} empty="Nothing pending" />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-bold">Available Alternative-Day Credits</CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Employee</TableHead>
                <TableHead>Earned from OT on</TableHead>
                <TableHead className="pr-4 text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {availableCredits.length > 0 ? availableCredits.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="pl-4">
                    <p className="text-sm font-semibold">{c.employeeName}</p>
                    <p className="text-[11px] text-muted-foreground font-mono">{c.employeeCode}</p>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{c.sourceDate ?? "—"}</TableCell>
                  <TableCell className="pr-4 text-right">
                    <Button size="sm" variant="outline" onClick={() => redeem(c.id)} disabled={redeemMutation.isPending}>
                      Redeem
                    </Button>
                  </TableCell>
                </TableRow>
              )) : (
                <TableRow><TableCell colSpan={3} className="text-center py-8 text-muted-foreground">No available credits</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function BenefitTable({ rows, empty }: { rows: CompensationBenefitRow[]; empty: string }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-4">Employee</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Date</TableHead>
          <TableHead className="pr-4">Detail</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length > 0 ? rows.map((r, i) => (
          <TableRow key={`${r.employeeId}-${r.date}-${i}`}>
            <TableCell className="pl-4">
              <p className="text-sm font-semibold">{r.employeeName}</p>
              <p className="text-[11px] text-muted-foreground font-mono">{r.employeeCode}</p>
            </TableCell>
            <TableCell className="text-sm capitalize">{r.type}</TableCell>
            <TableCell className="text-sm text-muted-foreground">{r.date}</TableCell>
            <TableCell className="pr-4 text-xs text-muted-foreground">{r.detail}</TableCell>
          </TableRow>
        )) : (
          <TableRow><TableCell colSpan={4} className="text-center py-8 text-muted-foreground">{empty}</TableCell></TableRow>
        )}
      </TableBody>
    </Table>
  );
}
