import { useState } from "react";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useListEmployees } from "@/lib/api-client";
import {
  useIncrementSummary, useAddIncrement,
} from "@/lib/api-client/custom-hooks";
import {
  IndianRupee, Search, User, TrendingUp, ArrowUpRight, X, History,
} from "lucide-react";

const QUICK_PERCENTS = [5, 10, 15, 20];

const fmt = (n: number) =>
  `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

export default function Increment() {
  const { toast } = useToast();
  const today = new Date().toISOString().slice(0, 10);

  const [input, setInput] = useState("");
  const [searchCode, setSearchCode] = useState("");
  const [percent, setPercent] = useState<string>("");
  const [effectiveDate, setEffectiveDate] = useState(today);
  const [notes, setNotes] = useState("");

  const { data: employees } = useListEmployees({ status: "active" });
  const { data, isLoading, isError } = useIncrementSummary(searchCode);
  const addMutation = useAddIncrement();

  const suggestions = input.trim() && !searchCode
    ? (employees ?? []).filter(e =>
        e.employeeCode.toLowerCase().includes(input.toLowerCase()) ||
        `${e.firstName} ${e.lastName}`.toLowerCase().includes(input.toLowerCase()),
      ).slice(0, 6)
    : [];

  const pct = parseFloat(percent);
  const projected = data && pct > 0
    ? data.currentSalary * (1 + pct / 100)
    : null;

  const applyIncrement = async () => {
    if (!data) return;
    if (!pct || pct <= 0) {
      toast({ title: "Enter a valid increment percentage", variant: "destructive" });
      return;
    }
    try {
      await addMutation.mutateAsync({
        employeeId: data.employee.id,
        percent: pct,
        effectiveDate,
        notes: notes || undefined,
      });
      toast({
        title: "Increment applied",
        description: `${data.employee.name}: ${fmt(data.currentSalary)} → ${fmt(projected!)} (+${pct}%)`,
      });
      setPercent("");
      setNotes("");
    } catch (err: any) {
      toast({ title: err?.message ?? "Failed to apply increment", variant: "destructive" });
    }
  };

  return (
    <HrLayout>
      <div className="space-y-5">
        <div>
          <h2 className="text-2xl font-black text-gray-900">Salary Increment</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Track salary growth and apply percentage-based increments
          </p>
        </div>

        {/* Search */}
        <Card className="border">
          <CardContent className="p-4">
            <div className="relative max-w-md">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
              <Input
                className="pl-8"
                placeholder="Search by employee code or name…"
                value={input}
                onChange={e => { setInput(e.target.value); setSearchCode(""); }}
                onKeyDown={e => { if (e.key === "Enter" && input.trim()) setSearchCode(input.trim()); }}
              />
              {searchCode && (
                <button
                  onClick={() => { setInput(""); setSearchCode(""); }}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  <X size={13} />
                </button>
              )}
              {suggestions.length > 0 && (
                <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-white border rounded-xl shadow-lg overflow-hidden">
                  {suggestions.map(emp => (
                    <button
                      key={emp.id}
                      className="w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-gray-50 text-left"
                      onMouseDown={e => {
                        e.preventDefault();
                        setInput(emp.employeeCode);
                        setSearchCode(emp.employeeCode);
                      }}
                    >
                      <div className="w-7 h-7 rounded-full bg-gray-100 flex items-center justify-center shrink-0">
                        <User size={12} className="text-gray-400" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold truncate">{emp.firstName} {emp.lastName}</p>
                        <p className="text-xs text-gray-400 font-mono">{emp.employeeCode}{emp.departmentName ? ` · ${emp.departmentName}` : ""}</p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {searchCode && (isLoading ? (
          <div className="grid lg:grid-cols-3 gap-4">
            {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)}
          </div>
        ) : isError || !data ? (
          <Card className="border">
            <CardContent className="py-10 text-center text-sm text-red-500">
              No employee found with code "{searchCode}".
            </CardContent>
          </Card>
        ) : (
          <>
            {/* Salary picture */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              {[
                { label: "Current Salary", value: fmt(data.currentSalary), cls: "text-gray-900", icon: IndianRupee, iconCls: "bg-gray-700" },
                { label: "Initial Salary", value: fmt(data.initialSalary), cls: "text-blue-700", icon: History, iconCls: "bg-blue-600" },
                { label: "Total Increment", value: fmt(data.totalIncrementAmount), cls: "text-green-700", icon: TrendingUp, iconCls: "bg-green-600" },
                { label: "Increments Given", value: String(data.totalIncrements), cls: "text-purple-700", icon: ArrowUpRight, iconCls: "bg-purple-600" },
              ].map(({ label, value, cls, icon: Icon, iconCls }) => (
                <Card key={label} className="border">
                  <CardContent className="p-5">
                    <div className="flex items-center justify-between mb-3">
                      <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">{label}</p>
                      <div className={`p-1.5 rounded-lg ${iconCls}`}>
                        <Icon size={14} className="text-white" />
                      </div>
                    </div>
                    <p className={`text-2xl font-black leading-none ${cls}`}>{value}</p>
                  </CardContent>
                </Card>
              ))}
            </div>

            <div className="grid lg:grid-cols-2 gap-4">
              {/* Add increment */}
              <Card className="border-2 border-green-100">
                <CardHeader className="pb-3 pt-4 px-4">
                  <CardTitle className="text-sm font-bold flex items-center gap-2 text-green-700">
                    <TrendingUp size={14} /> Add Salary Increment — {data.employee.name}
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-4 pb-4 space-y-4">
                  <div className="space-y-2">
                    <Label className="text-xs">Quick Select</Label>
                    <div className="flex items-center gap-2 flex-wrap">
                      {QUICK_PERCENTS.map(p => (
                        <button
                          key={p}
                          onClick={() => setPercent(String(p))}
                          className={`px-4 py-2 rounded-xl border-2 text-sm font-bold transition-all ${
                            percent === String(p)
                              ? "border-green-500 bg-green-50 text-green-700"
                              : "border-gray-200 text-gray-600 hover:border-gray-300"
                          }`}
                        >
                          +{p}%
                        </button>
                      ))}
                      <div className="relative">
                        <Input
                          type="number" min={0.1} max={500} step={0.1}
                          placeholder="Custom %"
                          value={QUICK_PERCENTS.map(String).includes(percent) ? "" : percent}
                          onChange={e => setPercent(e.target.value)}
                          className="w-28 h-10"
                        />
                      </div>
                    </div>
                  </div>

                  {projected !== null && (
                    <div className="p-3 bg-green-50 border border-green-200 rounded-xl text-sm">
                      <p className="text-xs text-green-600 font-semibold mb-1">Preview</p>
                      <p className="font-bold text-gray-800">
                        {fmt(data.currentSalary)}
                        <ArrowUpRight size={14} className="inline mx-1.5 text-green-600" />
                        <span className="text-green-700">{fmt(projected)}</span>
                        <span className="ml-2 text-xs font-semibold text-green-600">
                          (+{fmt(projected - data.currentSalary)} / +{pct}%)
                        </span>
                      </p>
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label className="text-xs">Effective Date</Label>
                      <Input type="date" value={effectiveDate} onChange={e => setEffectiveDate(e.target.value)} />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Notes</Label>
                      <Input placeholder="e.g. Annual appraisal" value={notes} onChange={e => setNotes(e.target.value)} />
                    </div>
                  </div>

                  <Button
                    className="w-full gap-2 bg-green-600 hover:bg-green-700"
                    onClick={applyIncrement}
                    disabled={addMutation.isPending || !pct}
                  >
                    <TrendingUp size={14} />
                    {addMutation.isPending ? "Applying…" : "Apply Increment"}
                  </Button>
                </CardContent>
              </Card>

              {/* History */}
              <Card className="border">
                <CardHeader className="pb-3 pt-4 px-4">
                  <CardTitle className="text-sm font-bold flex items-center gap-2">
                    <History size={14} className="text-gray-400" /> Increment History ({data.history.length})
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-4 pb-4">
                  {data.history.length === 0 ? (
                    <p className="text-sm text-center text-muted-foreground py-8">
                      No increments recorded yet. The current salary is the joining salary.
                    </p>
                  ) : (
                    <div className="space-y-2 max-h-96 overflow-y-auto">
                      {data.history.map(h => (
                        <div key={h.id} className="flex items-center gap-3 p-3 border rounded-xl">
                          <div className="w-8 h-8 rounded-lg bg-green-50 flex items-center justify-center shrink-0">
                            <ArrowUpRight size={14} className="text-green-600" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-bold text-gray-800">
                              {fmt(h.previousSalary)} → {fmt(h.newSalary)}
                            </p>
                            {h.notes && <p className="text-[11px] text-gray-400 truncate">{h.notes}</p>}
                          </div>
                          <div className="text-right shrink-0">
                            <p className="text-xs font-black text-green-600">+{h.percent}%</p>
                            <p className="text-[10px] text-gray-400">{h.effectiveDate}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </>
        ))}
      </div>
    </HrLayout>
  );
}
