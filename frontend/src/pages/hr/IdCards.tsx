import { useMemo, useState } from "react";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useListEmployees } from "@/lib/api-client";
import {
  useIdCards, useEmailIdCard, type IdCardData,
} from "@/lib/api-client/custom-hooks";
import {
  useQrCodes, StaffCardFront, StaffCardBack, ProductionCardFront, ProductionCardBack,
} from "@/components/idcard/IdCardViews";
import {
  CreditCard, Search, Printer, Mail, CheckSquare, Square,
  Briefcase, Factory,
} from "lucide-react";

// ── Page ───────────────────────────────────────────────────────────────────

export default function IdCards() {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | "staff" | "production">("all");
  const [selectedIds, setSelectedIds] = useState<number[]>([]);

  const { data: employees } = useListEmployees({ status: "active" });
  const { data: cards, isLoading: cardsLoading } = useIdCards(selectedIds);
  const emailMutation = useEmailIdCard();

  const filtered = useMemo(() => (employees ?? []).filter(e => {
    const q = search.trim().toLowerCase();
    const matchQ = !q ||
      e.employeeCode.toLowerCase().includes(q) ||
      `${e.firstName} ${e.lastName}`.toLowerCase().includes(q);
    const matchT = typeFilter === "all" || e.employmentType === typeFilter;
    return matchQ && matchT;
  }), [employees, search, typeFilter]);

  const qrs = useQrCodes(cards ?? []);

  const toggle = (id: number) =>
    setSelectedIds(ids => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]);

  const toggleAll = () =>
    setSelectedIds(ids =>
      ids.length === filtered.length ? [] : filtered.map(e => e.id));

  const handlePrint = () => {
    if ((cards ?? []).length === 0) {
      toast({ title: "Select at least one employee first", variant: "destructive" });
      return;
    }
    window.print();
  };

  const handleEmail = async (card: IdCardData) => {
    try {
      const res = await emailMutation.mutateAsync({ employeeId: card.id });
      toast({ title: `ID card emailed to ${res.sentTo}` });
    } catch (err: any) {
      toast({ title: err?.message ?? "Email failed — check SMTP settings", variant: "destructive" });
    }
  };

  return (
    <HrLayout>
      {/* Print-only stylesheet: show cards only */}
      <style>{`
        @media print {
          body * { visibility: hidden; }
          .print-area, .print-area * { visibility: visible; }
          .print-area { position: absolute; left: 0; top: 0; width: 100%; }
          .idcard { box-shadow: none !important; page-break-inside: avoid; }
          .no-print { display: none !important; }
        }
      `}</style>

      <div className="space-y-5">
        <div className="flex items-start justify-between gap-3 flex-wrap no-print">
          <div>
            <h2 className="text-2xl font-black text-gray-900">ID Card Generator</h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              Garments-style employee identity cards · staff = vertical, production = horizontal ·
              QR verification built in
            </p>
          </div>
          <Button onClick={handlePrint} className="gap-2 h-9" disabled={(cards ?? []).length === 0}>
            <Printer size={14} /> Print Selected ({selectedIds.length})
          </Button>
        </div>

        <div className="grid lg:grid-cols-[320px_1fr] gap-4 items-start">
          {/* ── Employee picker ── */}
          <Card className="border no-print">
            <CardContent className="p-3 space-y-2.5">
              <div className="relative">
                <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                <Input
                  className="pl-8 h-8 text-xs"
                  placeholder="Search employees…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
              </div>
              <div className="flex items-center gap-1">
                {(["all", "staff", "production"] as const).map(t => (
                  <button
                    key={t}
                    onClick={() => setTypeFilter(t)}
                    className={`text-[11px] px-2.5 py-1 rounded-full border font-semibold capitalize transition-all ${
                      typeFilter === t ? "bg-gray-900 text-white border-gray-900" : "bg-white text-gray-600"
                    }`}
                  >
                    {t}
                  </button>
                ))}
                <button
                  onClick={toggleAll}
                  className="ml-auto text-[11px] text-blue-600 font-semibold hover:underline"
                >
                  {selectedIds.length === filtered.length && filtered.length > 0 ? "Clear all" : "Select all"}
                </button>
              </div>
              <div className="max-h-[520px] overflow-y-auto space-y-1">
                {filtered.map(emp => {
                  const checked = selectedIds.includes(emp.id);
                  return (
                    <button
                      key={emp.id}
                      onClick={() => toggle(emp.id)}
                      className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left transition-colors ${
                        checked ? "bg-blue-50 border border-blue-200" : "hover:bg-gray-50 border border-transparent"
                      }`}
                    >
                      {checked
                        ? <CheckSquare size={14} className="text-blue-600 shrink-0" />
                        : <Square size={14} className="text-gray-300 shrink-0" />}
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-semibold truncate">{emp.firstName} {emp.lastName}</p>
                        <p className="text-[10px] text-gray-400 font-mono">{emp.employeeCode}</p>
                      </div>
                      {emp.employmentType === "production"
                        ? <Factory size={11} className="text-orange-400 shrink-0" />
                        : <Briefcase size={11} className="text-blue-400 shrink-0" />}
                    </button>
                  );
                })}
                {filtered.length === 0 && (
                  <p className="text-xs text-center text-gray-400 py-6">No employees match.</p>
                )}
              </div>
            </CardContent>
          </Card>

          {/* ── Card previews ── */}
          <div className="print-area">
            {selectedIds.length === 0 ? (
              <Card className="border no-print">
                <CardContent className="py-20 text-center">
                  <CreditCard size={40} className="text-gray-200 mx-auto mb-3" />
                  <p className="text-sm text-gray-500">Select employees on the left to generate their ID cards.</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Staff cards are vertical with photo · production cards are horizontal.
                  </p>
                </CardContent>
              </Card>
            ) : cardsLoading ? (
              <div className="flex gap-4 flex-wrap">
                {Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="w-[240px] h-[380px] rounded-2xl" />)}
              </div>
            ) : (
              <div className="space-y-6">
                {(cards ?? []).map(card => (
                  <div key={card.id} className="space-y-2">
                    <div className="flex items-center gap-2 no-print">
                      <p className="text-xs font-bold text-gray-600">
                        {card.name} <span className="font-mono text-gray-400">({card.code})</span>
                      </p>
                      <Button
                        size="sm" variant="outline"
                        className="h-7 gap-1.5 text-xs ml-auto"
                        onClick={() => handleEmail(card)}
                        disabled={emailMutation.isPending}
                      >
                        <Mail size={11} /> Email to employee
                      </Button>
                    </div>
                    <div className="flex gap-4 flex-wrap">
                      {card.employmentType === "production" ? (
                        <>
                          <ProductionCardFront card={card} />
                          <ProductionCardBack card={card} qr={qrs[card.code]} />
                        </>
                      ) : (
                        <>
                          <StaffCardFront card={card} />
                          <StaffCardBack card={card} qr={qrs[card.code]} />
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </HrLayout>
  );
}
