import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
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
  CreditCard, Search, Printer, Mail, User, CheckSquare, Square,
  Briefcase, Factory, Droplets, Phone, MapPin, Cake,
} from "lucide-react";

// ── Brand colours (UKTextiles sky-blue) ────────────────────────────────────
const BRAND = "#4FB8F0";
const BRAND_DARK = "#006496";

function useQrCodes(cards: IdCardData[]) {
  const [qrs, setQrs] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const out: Record<string, string> = {};
      for (const c of cards) {
        const url = `${window.location.origin}/verify/${encodeURIComponent(c.code)}`;
        out[c.code] = await QRCode.toDataURL(url, {
          width: 160, margin: 1,
          color: { dark: "#0f172a", light: "#ffffff" },
        });
      }
      if (!cancelled) setQrs(out);
    })();
    return () => { cancelled = true; };
  }, [cards.map(c => c.code).join(",")]);
  return qrs;
}

// ── Card front/back components ─────────────────────────────────────────────

function CompanyHeader({ card, compact }: { card: IdCardData; compact?: boolean }) {
  return (
    <div
      className="flex items-center gap-2 px-3"
      style={{ background: `linear-gradient(120deg, ${BRAND_DARK}, ${BRAND})`, paddingTop: compact ? 8 : 12, paddingBottom: compact ? 8 : 12 }}
    >
      {card.company.logo ? (
        <img src={card.company.logo} alt="" className="h-8 w-8 object-contain bg-white rounded-full p-0.5 shrink-0" />
      ) : (
        <div className="h-8 w-8 rounded-full bg-white flex items-center justify-center shrink-0">
          <span className="text-[10px] font-black" style={{ color: BRAND_DARK }}>UK</span>
        </div>
      )}
      <div className="min-w-0 text-white">
        <p className="font-black leading-tight truncate" style={{ fontSize: compact ? 11 : 13 }}>
          {card.company.name}
        </p>
        <p className="text-[8px] opacity-90 leading-tight truncate">{card.company.address}</p>
      </div>
    </div>
  );
}

function StaffCardFront({ card }: { card: IdCardData }) {
  return (
    <div className="idcard w-[240px] h-[380px] bg-white rounded-2xl overflow-hidden shadow-lg border flex flex-col shrink-0">
      <CompanyHeader card={card} />
      <div className="text-center py-1.5" style={{ background: "#eaf6fd" }}>
        <p className="text-[8px] font-black tracking-[0.2em] uppercase" style={{ color: BRAND_DARK }}>
          Employee Identity Card
        </p>
      </div>
      <div className="flex-1 flex flex-col items-center px-4 pt-3">
        <div
          className="w-24 h-28 rounded-xl overflow-hidden border-4 flex items-center justify-center bg-gray-50"
          style={{ borderColor: BRAND }}
        >
          {card.photoUrl
            ? <img src={card.photoUrl} className="w-full h-full object-cover" alt="" />
            : <User size={38} className="text-gray-300" />}
        </div>
        <p className="mt-2.5 font-black text-[15px] text-gray-900 text-center leading-tight">{card.name}</p>
        <p className="text-[10px] font-bold" style={{ color: BRAND_DARK }}>{card.designation ?? "—"}</p>
        <div className="w-full mt-2.5 space-y-1 text-[9px]">
          {[
            ["Emp Code", card.code],
            ["Department", card.department ?? "—"],
            ["Date of Issue", new Date().toLocaleDateString("en-IN")],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between border-b border-dashed border-gray-200 pb-0.5">
              <span className="text-gray-400 font-semibold">{k}</span>
              <span className="font-bold text-gray-900 font-mono">{v}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="h-2.5" style={{ background: `linear-gradient(90deg, ${BRAND_DARK}, ${BRAND})` }} />
    </div>
  );
}

function StaffCardBack({ card, qr }: { card: IdCardData; qr?: string }) {
  return (
    <div className="idcard w-[240px] h-[380px] bg-white rounded-2xl overflow-hidden shadow-lg border flex flex-col shrink-0">
      <div className="h-2.5" style={{ background: `linear-gradient(90deg, ${BRAND}, ${BRAND_DARK})` }} />
      <div className="flex-1 px-4 pt-3 space-y-2">
        <div className="space-y-1 text-[9px]">
          {[
            { icon: Droplets, k: "Blood Group", v: card.bloodGroup ?? "—" },
            { icon: Cake, k: "Date of Birth", v: card.dateOfBirth ?? "—" },
            { icon: Phone, k: "Emergency", v: card.emergencyContact ?? card.phone ?? "—" },
          ].map(({ icon: Icon, k, v }) => (
            <div key={k} className="flex items-center gap-1.5 border-b border-dashed border-gray-200 pb-1">
              <Icon size={9} style={{ color: BRAND_DARK }} className="shrink-0" />
              <span className="text-gray-400 font-semibold">{k}</span>
              <span className="ml-auto font-bold text-gray-900 text-right">{v}</span>
            </div>
          ))}
          <div className="flex items-start gap-1.5 pb-0.5">
            <MapPin size={9} style={{ color: BRAND_DARK }} className="shrink-0 mt-0.5" />
            <span className="text-gray-400 font-semibold shrink-0">Address</span>
            <span className="ml-auto font-semibold text-gray-800 text-right leading-tight line-clamp-3">
              {card.address ?? "—"}
            </span>
          </div>
        </div>

        <div className="flex flex-col items-center pt-0.5">
          {qr ? <img src={qr} className="w-20 h-20" alt="QR" /> : <div className="w-20 h-20 bg-gray-100 rounded" />}
          <p className="text-[7px] text-gray-400 font-semibold mt-0.5">SCAN TO VERIFY EMPLOYEE</p>
        </div>

        <div className="text-[7px] text-gray-500 leading-snug">
          <p className="font-bold text-gray-600 mb-0.5">INSTRUCTIONS</p>
          <p>• This card must be worn visibly inside company premises.</p>
          <p>• Card is company property — return on exit/resignation.</p>
          <p>• If found, please return to {card.company.name}, {card.company.address}.</p>
        </div>
      </div>
      <div className="flex items-end justify-between px-4 pb-2">
        <div className="text-center">
          {card.company.signature && <img src={card.company.signature} className="h-6 object-contain" alt="" />}
          <p className="text-[7px] text-gray-400 border-t border-gray-300 pt-0.5 font-semibold">Authorised Signatory</p>
        </div>
        <p className="text-[7px] font-mono text-gray-300">{card.code}</p>
      </div>
    </div>
  );
}

function ProductionCardFront({ card }: { card: IdCardData }) {
  return (
    <div className="idcard w-[380px] h-[240px] bg-white rounded-2xl overflow-hidden shadow-lg border flex flex-col shrink-0">
      <CompanyHeader card={card} compact />
      <div className="text-center py-1" style={{ background: "#eaf6fd" }}>
        <p className="text-[8px] font-black tracking-[0.2em] uppercase" style={{ color: BRAND_DARK }}>
          Employee Identity Card — Production
        </p>
      </div>
      <div className="flex-1 flex items-center gap-3 px-4">
        <div
          className="w-20 h-24 rounded-xl overflow-hidden border-4 flex items-center justify-center bg-gray-50 shrink-0"
          style={{ borderColor: BRAND }}
        >
          {card.photoUrl
            ? <img src={card.photoUrl} className="w-full h-full object-cover" alt="" />
            : <User size={30} className="text-gray-300" />}
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-black text-[15px] text-gray-900 leading-tight truncate">{card.name}</p>
          <p className="text-[10px] font-bold mb-1.5" style={{ color: BRAND_DARK }}>{card.designation ?? "Production Operator"}</p>
          <div className="space-y-0.5 text-[9px]">
            {[
              ["Emp Code", card.code],
              ["Department", card.department ?? "—"],
              ["Date of Issue", new Date().toLocaleDateString("en-IN")],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between border-b border-dashed border-gray-200 pb-0.5">
                <span className="text-gray-400 font-semibold">{k}</span>
                <span className="font-bold text-gray-900 font-mono">{v}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="h-2.5" style={{ background: `linear-gradient(90deg, ${BRAND_DARK}, ${BRAND})` }} />
    </div>
  );
}

function ProductionCardBack({ card, qr }: { card: IdCardData; qr?: string }) {
  return (
    <div className="idcard w-[380px] h-[240px] bg-white rounded-2xl overflow-hidden shadow-lg border flex flex-col shrink-0">
      <div className="h-2.5" style={{ background: `linear-gradient(90deg, ${BRAND}, ${BRAND_DARK})` }} />
      <div className="flex-1 flex gap-3 px-4 pt-2.5">
        <div className="flex-1 space-y-1 text-[9px]">
          {[
            { icon: Droplets, k: "Blood Group", v: card.bloodGroup ?? "—" },
            { icon: Cake, k: "Date of Birth", v: card.dateOfBirth ?? "—" },
            { icon: Phone, k: "Emergency", v: card.emergencyContact ?? card.phone ?? "—" },
          ].map(({ icon: Icon, k, v }) => (
            <div key={k} className="flex items-center gap-1.5 border-b border-dashed border-gray-200 pb-1">
              <Icon size={9} style={{ color: BRAND_DARK }} className="shrink-0" />
              <span className="text-gray-400 font-semibold">{k}</span>
              <span className="ml-auto font-bold text-gray-900">{v}</span>
            </div>
          ))}
          <div className="flex items-start gap-1.5">
            <MapPin size={9} style={{ color: BRAND_DARK }} className="shrink-0 mt-0.5" />
            <span className="text-gray-400 font-semibold shrink-0">Address</span>
            <span className="ml-auto font-semibold text-gray-800 text-right leading-tight line-clamp-2">
              {card.address ?? "—"}
            </span>
          </div>
          <div className="text-[7px] text-gray-500 leading-snug pt-1">
            <p className="font-bold text-gray-600 mb-0.5">INSTRUCTIONS</p>
            <p>• Wear this card visibly inside company premises.</p>
            <p>• Card is company property — return on exit.</p>
            <p>• If found, return to {card.company.name}.</p>
          </div>
        </div>
        <div className="flex flex-col items-center justify-center shrink-0">
          {qr ? <img src={qr} className="w-24 h-24" alt="QR" /> : <div className="w-24 h-24 bg-gray-100 rounded" />}
          <p className="text-[7px] text-gray-400 font-semibold mt-1">SCAN TO VERIFY</p>
          <div className="text-center mt-2">
            {card.company.signature && <img src={card.company.signature} className="h-5 object-contain mx-auto" alt="" />}
            <p className="text-[7px] text-gray-400 border-t border-gray-300 pt-0.5 font-semibold">Authorised Signatory</p>
          </div>
        </div>
      </div>
      <div className="h-1.5" />
    </div>
  );
}

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
