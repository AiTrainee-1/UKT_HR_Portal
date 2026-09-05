import { useState, useEffect } from "react";
import ExcelJS from "exceljs";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CircleLoader } from "@/components/ui/CircleLoader";
import { useListDepartments } from "@/lib/api-client";
import { useListBranches, getListBranchesQueryKey, useCompensation, type CompensationRow } from "@/lib/api-client/custom-hooks";
import { useAuth } from "@/contexts/AuthContext";
import { Search, Download, Landmark } from "lucide-react";

const fmt = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

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

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [deptFilter, setDeptFilter] = useState("all");
  const [branchFilter, setBranchFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
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
    <HrLayout>
      <div className="space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-black flex items-center gap-2">
              <Landmark size={20} className="text-teal-600" /> Compensation
            </h2>
            <p className="text-muted-foreground text-sm mt-0.5">
              {data?.count ?? 0} employee{(data?.count ?? 0) !== 1 ? "s" : ""} · CTC breakdown by department, HRA/Basic split configurable in Settings → Payroll
            </p>
          </div>
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
    </HrLayout>
  );
}
