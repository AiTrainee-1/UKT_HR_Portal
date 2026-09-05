import { useMemo, useState } from "react";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CircleLoader } from "@/components/ui/CircleLoader";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import {
  useBonusCalculate, useBonusList, useGenerateBonus, useUpdateBonus,
  downloadAuthedFile, type BonusItem,
} from "@/lib/api-client/custom-hooks";
import {
  Gift, Info, Percent, Calendar, IndianRupee, Scale, Users, Download, RefreshCw, ChevronDown,
} from "lucide-react";

const fmt = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

function defaultFinancialYear(): string {
  const now = new Date();
  const startYear = now.getMonth() + 1 >= 4 ? now.getFullYear() : now.getFullYear() - 1;
  return `${startYear}-${String(startYear + 1).slice(-2)}`;
}

function financialYearOptions(): string[] {
  const current = defaultFinancialYear();
  const startYear = parseInt(current.split("-")[0], 10);
  return Array.from({ length: 6 }, (_, i) => {
    const y = startYear - i;
    return `${y}-${String(y + 1).slice(-2)}`;
  });
}

const STATUS_LABEL: Record<BonusItem["status"], string> = {
  calculated: "Calculated",
  approved: "Approved",
  paid: "Paid",
};

export default function Bonus() {
  const { toast } = useToast();
  const { token } = useAuth();
  const [fy, setFy] = useState(defaultFinancialYear());
  const [showInfo, setShowInfo] = useState(false);
  const fyOptions = useMemo(financialYearOptions, []);

  const { data: persisted, isLoading: persistedLoading } = useBonusList(fy);
  const hasPersisted = (persisted?.results.length ?? 0) > 0;
  const { data: preview, isLoading: previewLoading } = useBonusCalculate(fy, !persistedLoading && !hasPersisted);

  const generateMutation = useGenerateBonus();
  const updateMutation = useUpdateBonus();

  const isLoading = persistedLoading || (!hasPersisted && previewLoading);

  const summary = hasPersisted
    ? {
        totalEligible: persisted!.results.length,
        totalBonusAmount: persisted!.results.reduce((s, r) => s + r.bonusAmount, 0),
        avgBonusAmount: persisted!.results.length
          ? persisted!.results.reduce((s, r) => s + r.bonusAmount, 0) / persisted!.results.length
          : 0,
      }
    : preview
      ? { totalEligible: preview.totalEligible, totalBonusAmount: preview.totalBonusAmount, avgBonusAmount: preview.avgBonusAmount }
      : null;

  const handleGenerate = async () => {
    try {
      const result = await generateMutation.mutateAsync(fy);
      toast({ title: `Generated bonus for ${result.generated} employee(s)`, description: `Financial year ${fy}` });
    } catch (err: any) {
      toast({ title: err?.message ?? "Failed to generate bonus", variant: "destructive" });
    }
  };

  const handleStatusChange = async (id: number, status: BonusItem["status"]) => {
    try {
      await updateMutation.mutateAsync({ id, data: { status } });
      toast({ title: `Marked as ${STATUS_LABEL[status]}` });
    } catch (err: any) {
      toast({ title: err?.message ?? "Failed to update", variant: "destructive" });
    }
  };

  const handleExport = async () => {
    try {
      await downloadAuthedFile(`/api/bonus/export?financialYear=${encodeURIComponent(fy)}`, `bonus-register-${fy}.xlsx`, () => token);
    } catch (err: any) {
      toast({ title: err?.message ?? "Export failed", variant: "destructive" });
    }
  };

  return (
    <HrLayout>
      <div className="space-y-5">
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div>
            <h2 className="text-2xl font-black text-gray-900 flex items-center gap-2">
              <Gift size={20} className="text-pink-500" /> Bonus
            </h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              Statutory annual bonus -Payment of Bonus Act, 1965
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Select value={fy} onValueChange={setFy}>
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {fyOptions.map((y) => (
                  <SelectItem key={y} value={y}>FY {y}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {hasPersisted && (
              <Button variant="outline" onClick={handleExport}>
                <Download size={15} className="mr-2" /> Export
              </Button>
            )}
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button disabled={generateMutation.isPending}>
                  <RefreshCw size={15} className="mr-2" />
                  {generateMutation.isPending ? "Generating…" : `Generate for FY ${fy}`}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Generate bonus register for FY {fy}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This calculates and saves a real bonus record for every eligible employee, based on
                    their salary slips for this financial year. Running it again for the same year updates
                    existing records rather than duplicating them.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={handleGenerate}>Generate</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>

        {!hasPersisted && !isLoading && (
          <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-800">
            <Info size={14} className="shrink-0 mt-0.5" />
            <span>
              FY {fy} hasn't been generated yet -showing a <strong>live preview</strong>. Nothing is saved
              until you click "Generate for FY {fy}".
            </span>
          </div>
        )}

        {/* Summary cards */}
        {isLoading ? (
          <CircleLoader />
        ) : summary ? (
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
            {[
              { label: "Eligible Employees", value: String(summary.totalEligible), icon: Users, iconCls: "bg-blue-600" },
              { label: "Total Bonus Payable", value: fmt(summary.totalBonusAmount), icon: IndianRupee, iconCls: "bg-green-600" },
              { label: "Average Bonus", value: fmt(summary.avgBonusAmount), icon: Percent, iconCls: "bg-purple-600" },
            ].map(({ label, value, icon: Icon, iconCls }) => (
              <Card key={label} className="border">
                <CardContent className="p-5">
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">{label}</p>
                    <div className={`p-1.5 rounded-lg ${iconCls}`}>
                      <Icon size={14} className="text-white" />
                    </div>
                  </div>
                  <p className="text-2xl font-black leading-none text-gray-900">{value}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : null}

        {/* Register table */}
        {!isLoading && (
          <Card>
            <CardContent className="p-0 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">Code</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Department</TableHead>
                    <TableHead className="text-right">Records</TableHead>
                    <TableHead className="text-right">Calculation Base</TableHead>
                    <TableHead className="text-right">Bonus %</TableHead>
                    <TableHead className="text-right">Bonus Amount</TableHead>
                    <TableHead className="pr-4">{hasPersisted ? "Status" : "Eligibility"}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {hasPersisted ? (
                    persisted!.results.length > 0 ? persisted!.results.map((b) => (
                      <TableRow key={b.id}>
                        <TableCell className="pl-4 font-mono text-xs">{b.employeeCode}</TableCell>
                        <TableCell className="font-semibold text-sm">{b.employeeName}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{b.department ?? "—"}</TableCell>
                        <TableCell className="text-right text-sm">{b.recordsConsidered}</TableCell>
                        <TableCell className="text-right text-sm">{fmt(b.calculationBase)}</TableCell>
                        <TableCell className="text-right text-sm">{b.bonusPercentApplied}%</TableCell>
                        <TableCell className="text-right text-sm font-bold text-green-700">{fmt(b.bonusAmount)}</TableCell>
                        <TableCell className="pr-4">
                          <Select value={b.status} onValueChange={(v) => handleStatusChange(b.id, v as BonusItem["status"])}>
                            <SelectTrigger className="h-8 w-32 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="calculated">Calculated</SelectItem>
                              <SelectItem value="approved">Approved</SelectItem>
                              <SelectItem value="paid">Paid</SelectItem>
                            </SelectContent>
                          </Select>
                        </TableCell>
                      </TableRow>
                    )) : (
                      <TableRow><TableCell colSpan={8} className="text-center py-12 text-muted-foreground">No records</TableCell></TableRow>
                    )
                  ) : preview && preview.results.length > 0 ? preview.results.map((r) => (
                    <TableRow key={r.employeeId} className={r.eligible ? "" : "opacity-50"}>
                      <TableCell className="pl-4 font-mono text-xs">{r.employeeCode}</TableCell>
                      <TableCell className="font-semibold text-sm">{r.employeeName}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{r.department ?? "—"}</TableCell>
                      <TableCell className="text-right text-sm">{r.recordsConsidered}</TableCell>
                      <TableCell className="text-right text-sm">{fmt(r.calculationBase)}</TableCell>
                      <TableCell className="text-right text-sm">{r.bonusPercent}%</TableCell>
                      <TableCell className="text-right text-sm font-bold text-green-700">{fmt(r.bonusAmount)}</TableCell>
                      <TableCell className="pr-4">
                        {r.eligible ? (
                          <Badge className="bg-green-100 text-green-800">Eligible</Badge>
                        ) : (
                          <Badge variant="secondary" title={r.reason ?? undefined}>Ineligible</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  )) : (
                    <TableRow><TableCell colSpan={8} className="text-center py-12 text-muted-foreground">No employees found</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}

        {/* Reference info -collapsed by default now that real functionality exists above */}
        <Card className="border">
          <button
            type="button"
            onClick={() => setShowInfo((v) => !v)}
            className="w-full flex items-center justify-between px-5 py-3 text-left"
          >
            <span className="text-sm font-bold flex items-center gap-2 text-gray-700">
              <Scale size={14} className="text-blue-500" /> About the Payment of Bonus Act, 1965
            </span>
            <ChevronDown size={16} className={`text-gray-400 transition-transform ${showInfo ? "rotate-180" : ""}`} />
          </button>
          {showInfo && (
            <CardContent className="pt-0 space-y-4">
              <div className="grid sm:grid-cols-2 gap-4">
                {[
                  {
                    icon: Scale, color: "text-blue-600 bg-blue-50", title: "Eligibility",
                    body: "Applies to factories with 20+ employees. Employees earning up to ₹21,000/month who have worked at least 30 days in the accounting year are eligible for statutory bonus.",
                  },
                  {
                    icon: Percent, color: "text-green-600 bg-green-50", title: "Bonus Percentage",
                    body: "Minimum 8.33% of annual earned wages (basic + DA), maximum 20%. The rate applied here is configured in Settings → Payroll → Statutory Bonus.",
                  },
                  {
                    icon: IndianRupee, color: "text-purple-600 bg-purple-50", title: "Calculation Ceiling",
                    body: "For employees earning above the configured wage ceiling (default ₹7,000/month), bonus is calculated on the ceiling amount, not the full basic.",
                  },
                  {
                    icon: Calendar, color: "text-amber-600 bg-amber-50", title: "When It's Paid",
                    body: "In the garments industry, bonus is customarily paid before Diwali/Pongal. Statutorily it must be paid within 8 months of the close of the accounting year.",
                  },
                ].map(({ icon: Icon, color, title, body }) => (
                  <div key={title} className="flex gap-3">
                    <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${color}`}>
                      <Icon size={17} />
                    </div>
                    <div>
                      <p className="font-bold text-sm text-gray-900 mb-0.5">{title}</p>
                      <p className="text-xs text-gray-500 leading-relaxed">{body}</p>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          )}
        </Card>
      </div>
    </HrLayout>
  );
}
