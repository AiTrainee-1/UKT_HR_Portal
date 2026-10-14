import { useMemo, useState } from "react";
import { downloadWorkbook, newWorkbook, styleHeaderCell } from "@/lib/exportUtils";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CircleLoader } from "@/components/ui/CircleLoader";
import { useListDepartments } from "@/lib/api-client";
import {
  useListBranches,
  getListBranchesQueryKey,
  useCompensation,
  type CompensationRow,
} from "@/lib/api-client/custom-hooks";
import { Search, Download } from "lucide-react";
import { FIRST_PORTION, SECOND_PORTION } from "@/lib/salary-split";

const fmt = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

async function exportCompensation(rows: CompensationRow[]) {
  const wb = newWorkbook();
  const ws = wb.addWorksheet("Compensation");

  const columns = [
    { key: "employeeCode", label: "Code", width: 14 },
    { key: "employeeName", label: "Name", width: 22 },
    { key: "department", label: "Department", width: 18 },
    { key: "employmentType", label: "Type", width: 12 },
    // First portion (50%), then the second portion (50%): each component, then the portion's total
    ...FIRST_PORTION.map((f) => ({ key: f.key as string, label: f.label, width: 14 })),
    { key: "firstPortion", label: "First Portion (50%)", width: 18 },
    ...SECOND_PORTION.map((f) => ({ key: f.key as string, label: f.label, width: 14 })),
    { key: "secondPortion", label: "Second Portion (50%)", width: 20 },
    { key: "employerPf", label: "Employer PF", width: 14 },
    { key: "employerEsi", label: "Employer ESI", width: 14 },
    { key: "grossMonthly", label: "Gross Monthly", width: 16 },
    { key: "annualCtc", label: "Annual CTC", width: 16 },
    { key: "splitRecorded", label: "Salary Split", width: 14 },
  ];
  const currencyKeys = new Set([
    ...FIRST_PORTION.map((f) => f.key as string),
    ...SECOND_PORTION.map((f) => f.key as string),
    "firstPortion",
    "secondPortion",
    "employerPf",
    "employerEsi",
    "grossMonthly",
    "annualCtc",
  ]);

  ws.columns = columns.map((c) => ({ key: c.key, width: c.width }));
  const headerRow = ws.getRow(1);
  columns.forEach((col, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = col.label.toUpperCase();
    styleHeaderCell(cell, { fill: "FF006496", wrapText: false });
  });
  headerRow.height = 22;

  (rows ?? []).forEach((row, ri) => {
    const wsRow = ws.getRow(ri + 2);
    columns.forEach((col, ci) => {
      const cell = wsRow.getCell(ci + 1);
      const raw = (row as any)[col.key];
      if (col.key === "splitRecorded") {
        // no split at all (no monthly salary) reads blank; otherwise say whether it is saved or the automatic one
        cell.value = row.firstPortion === null ? "" : raw ? "Recorded" : "Automatic";
      } else if (currencyKeys.has(col.key)) {
        cell.value = raw !== null && raw !== undefined ? Number(raw) : null;
        cell.numFmt = "₹#,##0.00";
      } else {
        cell.value = raw ?? "";
      }
      cell.alignment = { horizontal: "center", vertical: "middle" };
    });
  });

  await downloadWorkbook(wb, `compensation-${Date.now()}.xlsx`);
}

// ── CTC Breakdown: the 50% + 50% salary split, then employer PF / ESI and annual CTC ────────
// (Unchanged by the Compensation overhaul: it only moved here from the page's single file.)

export default function CtcBreakdownTab({ isBranchScoped }: { isBranchScoped: boolean }) {
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
  const automaticCount = rows.filter((r) => r.firstPortion !== null && !r.splitRecorded).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground" data-testid="ctc-summary">
          {data?.count ?? 0} employee{(data?.count ?? 0) !== 1 ? "s" : ""} · salary shown as the 50% + 50% split from
          Add / Edit Employee · Employer PF is worked out on the first portion
          {automaticCount > 0 && (
            <>
              {" "}
              · <span className="text-amber-700">{automaticCount} showing the automatic split (not recorded yet)</span>
            </>
          )}
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
                <SelectItem key={d.id} value={String(d.id)}>
                  {d.name}
                </SelectItem>
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
                  <SelectItem key={b.id} value={String(b.id)}>
                    {b.name}
                  </SelectItem>
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
                <TableHead rowSpan={2} className="pl-4 align-bottom">
                  Code
                </TableHead>
                <TableHead rowSpan={2} className="align-bottom">
                  Name
                </TableHead>
                <TableHead rowSpan={2} className="align-bottom">
                  Department
                </TableHead>
                <TableHead rowSpan={2} className="align-bottom">
                  Designation
                </TableHead>
                <TableHead colSpan={FIRST_PORTION.length} className="text-center border-l bg-teal-50/60 text-teal-800">
                  First portion · 50%
                </TableHead>
                <TableHead colSpan={SECOND_PORTION.length} className="text-center border-l bg-blue-50/60 text-blue-800">
                  Second portion · 50%
                </TableHead>
                <TableHead rowSpan={2} className="text-right align-bottom border-l">
                  Employer PF
                </TableHead>
                <TableHead rowSpan={2} className="text-right align-bottom">
                  Employer ESI
                </TableHead>
                <TableHead rowSpan={2} className="text-right align-bottom">
                  Gross Monthly
                </TableHead>
                <TableHead rowSpan={2} className="pr-4 text-right align-bottom">
                  Annual CTC
                </TableHead>
              </TableRow>
              <TableRow>
                {FIRST_PORTION.map((f, i) => (
                  <TableHead key={f.key} className={`text-right bg-teal-50/60 ${i === 0 ? "border-l" : ""}`}>
                    {f.label}
                  </TableHead>
                ))}
                {SECOND_PORTION.map((f, i) => (
                  <TableHead key={f.key} className={`text-right bg-blue-50/60 ${i === 0 ? "border-l" : ""}`}>
                    {f.label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={16} className="py-16">
                    <CircleLoader />
                  </TableCell>
                </TableRow>
              ) : rows.length > 0 ? (
                rows.map((r) => (
                  <TableRow key={r.employeeId} data-testid={`ctc-row-${r.employeeCode}`}>
                    <TableCell className="pl-4 font-mono text-xs">{r.employeeCode}</TableCell>
                    <TableCell className="whitespace-nowrap font-semibold text-sm">
                      {r.employeeName}
                      {r.firstPortion !== null && !r.splitRecorded && (
                        <span
                          className="mt-0.5 block w-fit rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none tracking-wide text-amber-700"
                          title="No salary split is recorded for this employee yet, so the automatic 50% + 50% split is shown. Open Edit Employee and save to record it."
                          data-testid="ctc-auto-split"
                        >
                          Auto split
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{r.department ?? "—"}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{r.designation ?? "—"}</TableCell>
                    {[...FIRST_PORTION, ...SECOND_PORTION].map((f, i) => (
                      <TableCell
                        key={f.key}
                        className={`text-right text-sm tabular-nums ${i === 0 || i === FIRST_PORTION.length ? "border-l" : ""}`}
                      >
                        {r[f.key] === null ? "—" : fmt(r[f.key] as number)}
                      </TableCell>
                    ))}
                    <TableCell className="text-right text-sm border-l">{fmt(r.employerPf)}</TableCell>
                    <TableCell className="text-right text-sm">{fmt(r.employerEsi)}</TableCell>
                    <TableCell className="text-right text-sm font-semibold">{fmt(r.grossMonthly)}</TableCell>
                    <TableCell className="pr-4 text-right text-sm font-bold text-teal-700">
                      {fmt(r.annualCtc)}
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={16} className="text-center py-12 text-muted-foreground">
                    No employees found
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
