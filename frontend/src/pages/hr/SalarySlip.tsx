import { useState } from "react";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useListSalarySlips, SalarySlipItem } from "@/lib/api-client";
import { FileText, Download, Mail, Search, Printer } from "lucide-react";

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function SlipView({ slip }: { slip: SalarySlipItem }) {
  return (
    <div className="space-y-4 text-sm" id="salary-slip-print">
      <div className="text-center border-b pb-4">
        <h2 className="text-xl font-black text-gray-900">UKTextiles</h2>
        <p className="text-xs text-gray-500">uktextiles.in | On-Premise HR System</p>
        <p className="text-base font-bold mt-2 text-gray-700">SALARY SLIP — {MONTHS[slip.month - 1].toUpperCase()} {slip.year}</p>
      </div>

      <div className="grid grid-cols-2 gap-4 bg-gray-50 rounded-lg p-3 text-xs">
        <div className="space-y-1">
          <p><span className="text-gray-400">Employee Name:</span> <span className="font-semibold">{slip.employeeName}</span></p>
          <p><span className="text-gray-400">Employee Code:</span> <span className="font-semibold">{slip.employeeCode}</span></p>
          <p><span className="text-gray-400">Department:</span> <span className="font-semibold">{slip.departmentName ?? "—"}</span></p>
        </div>
        <div className="space-y-1">
          <p><span className="text-gray-400">Designation:</span> <span className="font-semibold">{slip.designationTitle ?? "—"}</span></p>
          <p><span className="text-gray-400">Working Days:</span> <span className="font-semibold">{slip.workingDays}</span></p>
          <p><span className="text-gray-400">Present Days:</span> <span className="font-semibold">{slip.presentDays}</span></p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <p className="font-bold text-xs text-gray-500 uppercase tracking-wide mb-2">Earnings</p>
          <div className="space-y-1 text-xs">
            {[
              { label: "Basic Salary",  value: slip.basic },
              { label: "HRA",           value: slip.hra },
              { label: "Allowances",    value: slip.allowances },
              { label: "Incentives",    value: slip.incentives },
              { label: "Bonuses",       value: slip.bonuses },
              { label: "OT Amount",     value: slip.otAmount },
            ].filter(r => r.value > 0).map(row => (
              <div key={row.label} className="flex justify-between">
                <span className="text-gray-500">{row.label}</span>
                <span className="font-medium">₹{row.value.toLocaleString("en-IN")}</span>
              </div>
            ))}
            <div className="flex justify-between font-bold border-t pt-1 mt-1">
              <span>Gross Salary</span>
              <span className="text-green-700">₹{slip.grossSalary.toLocaleString("en-IN")}</span>
            </div>
          </div>
        </div>
        <div>
          <p className="font-bold text-xs text-gray-500 uppercase tracking-wide mb-2">Deductions</p>
          <div className="space-y-1 text-xs">
            {[
              { label: "Provident Fund",   value: slip.pfDeduction },
              { label: "ESI",              value: slip.esiDeduction },
              { label: "Advance Recovery", value: slip.advanceDeduction },
              { label: "Other Deductions", value: slip.otherDeductions },
            ].filter(r => r.value > 0).map(row => (
              <div key={row.label} className="flex justify-between">
                <span className="text-gray-500">{row.label}</span>
                <span className="font-medium text-red-600">₹{row.value.toLocaleString("en-IN")}</span>
              </div>
            ))}
            <div className="flex justify-between font-bold border-t pt-1 mt-1">
              <span>Total Deductions</span>
              <span className="text-red-600">₹{slip.totalDeductions.toLocaleString("en-IN")}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="bg-gray-900 text-white rounded-xl p-4 flex items-center justify-between">
        <div>
          <p className="text-xs text-gray-400 font-medium uppercase tracking-wide">Net Salary Payable</p>
          <p className="text-xs text-gray-400 mt-0.5">{MONTHS[slip.month - 1]} {slip.year}</p>
        </div>
        <p className="text-2xl font-black">₹{slip.netSalary.toLocaleString("en-IN")}</p>
      </div>
    </div>
  );
}

export default function SalarySlipPage() {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [filterMonth, setFilterMonth] = useState(new Date().getMonth() + 1);
  const [filterYear, setFilterYear] = useState(new Date().getFullYear());
  const [viewingSlip, setViewingSlip] = useState<SalarySlipItem | null>(null);

  const { data: slips, isLoading } = useListSalarySlips({ month: filterMonth, year: filterYear });

  const filtered = (slips ?? []).filter(s =>
    !search ||
    s.employeeName.toLowerCase().includes(search.toLowerCase()) ||
    s.employeeCode.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <HrLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-black text-gray-900">Salary Slips</h2>
            <p className="text-muted-foreground text-sm mt-0.5">View and download generated salary slips</p>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <Input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search by employee name or code…" className="pl-9 h-9" />
          </div>
          <select value={filterMonth} onChange={e => setFilterMonth(Number(e.target.value))}
            className="h-9 rounded-md border px-3 text-sm bg-background">
            {MONTHS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
          </select>
          <Input type="number" value={filterYear} onChange={e => setFilterYear(Number(e.target.value))}
            className="h-9 w-24 text-sm" min={2020} max={2030} />
        </div>

        <div className="space-y-3">
          {isLoading ? (
            Array.from({ length: 4 }).map((_, i) => (
              <Card key={i} className="border-0 shadow-sm">
                <CardContent className="p-4">
                  <Skeleton className="h-5 w-40 mb-2" />
                  <Skeleton className="h-4 w-64" />
                </CardContent>
              </Card>
            ))
          ) : filtered.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <FileText size={32} className="mx-auto text-gray-200 mb-3" />
              <p className="text-sm">No salary slips found for {MONTHS[filterMonth - 1]} {filterYear}.</p>
              <p className="text-xs text-gray-400 mt-1">Generate payroll first to create salary slips.</p>
            </div>
          ) : (
            filtered.map(slip => (
              <Card key={slip.id} className="border hover:shadow-sm transition-shadow">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-bold text-sm text-gray-900">{slip.employeeName}</p>
                        <span className="text-xs text-gray-400">{slip.employeeCode}</span>
                        {slip.emailedAt && (
                          <Badge className="text-xs bg-green-50 text-green-700 border-green-200">Emailed</Badge>
                        )}
                      </div>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {slip.departmentName ?? "—"} · {slip.designationTitle ?? "—"}
                      </p>
                      <p className="text-xs text-gray-400 mt-0.5">
                        {slip.slipNumber} · Net: <strong className="text-gray-700">₹{slip.netSalary.toLocaleString("en-IN")}</strong>
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button variant="ghost" size="sm" className="h-8 gap-1 text-xs"
                        onClick={() => setViewingSlip(slip)}>
                        <FileText size={13} /> View
                      </Button>
                      <Button variant="ghost" size="sm" className="h-8 gap-1 text-xs"
                        onClick={() => toast({ title: "PDF download coming soon", variant: "default" })}>
                        <Download size={13} /> PDF
                      </Button>
                      <Button variant="ghost" size="sm" className="h-8 gap-1 text-xs"
                        onClick={() => toast({ title: `Salary slip email for ${slip.employeeName} — coming soon` })}>
                        <Mail size={13} /> Email
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </div>

        {viewingSlip && (
          <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
            onClick={() => setViewingSlip(null)}>
            <div className="bg-white rounded-2xl max-w-xl w-full max-h-[90vh] overflow-y-auto p-6"
              onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-5">
                <h3 className="font-bold text-base">Salary Slip Preview</h3>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" className="gap-1 text-xs"
                    onClick={() => window.print()}>
                    <Printer size={13} /> Print
                  </Button>
                  <Button size="sm" className="gap-1 text-xs"
                    onClick={() => toast({ title: "PDF download coming soon" })}>
                    <Download size={13} /> PDF
                  </Button>
                  <button onClick={() => setViewingSlip(null)}
                    className="text-gray-400 hover:text-gray-700 text-lg leading-none ml-2">×</button>
                </div>
              </div>
              <SlipView slip={viewingSlip} />
            </div>
          </div>
        )}
      </div>
    </HrLayout>
  );
}
