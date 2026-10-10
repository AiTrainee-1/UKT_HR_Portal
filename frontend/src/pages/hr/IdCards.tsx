import { useEffect, useMemo, useRef, useState } from "react";
import html2canvas from "html2canvas-pro";
import JSZip from "jszip";
import { AlertTriangle, Camera, CheckCircle2, CreditCard, Download, Printer, RefreshCw, Users } from "lucide-react";
import HrLayout from "@/components/HrLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CircleLoader } from "@/components/ui/CircleLoader";
import { useToast } from "@/hooks/use-toast";
import { useListEmployees } from "@/lib/api-client";
import { useEmailIdCard, useWhatsAppIdCard, type IdCardData } from "@/lib/api-client/custom-hooks";
import { useQrCodes } from "@/components/idcard/IdCardViews";
import { StatCard } from "./account-management/parts";
import { useIdCardsInChunks } from "./id-cards/api";
import CardPreview from "./id-cards/CardPreview";
import EmployeePicker from "./id-cards/EmployeePicker";
import { cardFileName, keepKnown, removeIds, summarizeEmployees, summarizeSelection, toggleId } from "./id-cards/logic";

// ── Page ───────────────────────────────────────────────────────────────────

/** A card (the element holding its front and back) as a PNG. */
async function capture(el: HTMLElement): Promise<Blob | null> {
  const canvas = await html2canvas(el, { backgroundColor: "#ffffff", scale: 3, useCORS: true });
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.download = filename;
  link.href = url;
  link.click();
  URL.revokeObjectURL(url);
}

export default function IdCards() {
  const { toast } = useToast();
  const [selectedIds, setSelectedIds] = useState<number[]>([]);

  const {
    data,
    isLoading: employeesLoading,
    isError: employeesError,
    refetch,
  } = useListEmployees({ status: "active" });
  const employees = useMemo(() => data ?? [], [data]);
  const {
    cards,
    isLoading: cardsLoading,
    isFetching: cardsFetching,
    isError: cardsError,
    refetch: refetchCards,
  } = useIdCardsInChunks(selectedIds);
  const emailMutation = useEmailIdCard();
  const whatsappMutation = useWhatsAppIdCard();
  const cardRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const [downloading, setDownloading] = useState<number | "all" | null>(null);

  const qrs = useQrCodes(cards);
  const summary = useMemo(() => summarizeEmployees(employees), [employees]);
  const selection = useMemo(() => summarizeSelection(employees, selectedIds), [employees, selectedIds]);

  // an employee who left (or moved out of this viewer's branch) while the page was open cannot be on a card
  useEffect(() => {
    if (employees.length === 0) return;
    setSelectedIds((ids) => {
      const kept = keepKnown(ids, employees);
      return kept.length === ids.length ? ids : kept;
    });
  }, [employees]);

  const qrReady = cards.length > 0 && cards.every((c) => !!qrs[c.code]);

  const handlePrint = () => {
    if (cards.length === 0) {
      toast({ title: "Select at least one employee first", variant: "destructive" });
      return;
    }
    if (!qrReady) {
      toast({ title: "Still preparing QR codes -try again in a moment", variant: "destructive" });
      return;
    }
    window.print();
  };

  const handleDownload = async () => {
    if (cards.length === 0) {
      toast({ title: "Select at least one employee first", variant: "destructive" });
      return;
    }
    if (!qrReady) {
      toast({ title: "Still preparing QR codes -try again in a moment", variant: "destructive" });
      return;
    }
    setDownloading("all");
    try {
      const zip = new JSZip();
      let captured = 0;
      for (const card of cards) {
        const el = cardRefs.current[card.id];
        if (!el) continue;
        const blob = await capture(el);
        if (!blob) continue;
        zip.file(cardFileName(card), blob);
        captured++;
      }
      if (captured === 0) throw new Error("No cards could be captured");
      saveBlob(await zip.generateAsync({ type: "blob" }), `ID-Cards-${new Date().toISOString().slice(0, 10)}.zip`);
      toast({ title: `${captured} ID card${captured === 1 ? "" : "s"} downloaded` });
    } catch (err) {
      console.error("ID card download failed:", err);
      toast({
        title: "Failed to download ID cards",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    } finally {
      setDownloading(null);
    }
  };

  const handleDownloadOne = async (card: IdCardData) => {
    const el = cardRefs.current[card.id];
    if (!el) return;
    setDownloading(card.id);
    try {
      const blob = await capture(el);
      if (!blob) throw new Error("The card could not be drawn");
      saveBlob(blob, cardFileName(card));
    } catch (err) {
      toast({
        title: "Failed to download the ID card",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    } finally {
      setDownloading(null);
    }
  };

  const handleEmail = async (card: IdCardData) => {
    try {
      const res = await emailMutation.mutateAsync({ employeeId: card.id });
      toast({ title: `ID card emailed to ${res.sentTo}` });
    } catch (err: unknown) {
      toast({
        title: err instanceof Error && err.message ? err.message : "Email failed -check SMTP settings",
        variant: "destructive",
      });
    }
  };

  const handleWhatsApp = async (card: IdCardData) => {
    try {
      const res = await whatsappMutation.mutateAsync(card.id);
      toast({ title: `ID card sent to ${res.sentTo}` });
    } catch (err: unknown) {
      toast({
        title: err instanceof Error && err.message ? err.message : "WhatsApp send failed",
        variant: "destructive",
      });
    }
  };

  const busy = downloading !== null;

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
        <div className="no-print flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-2xl font-black text-gray-900">ID Card Generator</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Garments-style employee identity cards · staff = vertical, production = horizontal · QR verification built
              in
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={handleDownload}
              className="h-9 gap-2"
              disabled={cards.length === 0 || busy}
              data-testid="id-download-all"
            >
              <Download size={14} />{" "}
              {downloading === "all" ? "Preparing…" : `Download Selected (${selectedIds.length})`}
            </Button>
            <Button
              onClick={handlePrint}
              className="h-9 gap-2"
              disabled={cards.length === 0 || busy}
              data-testid="id-print"
            >
              <Printer size={14} /> Print Selected ({selectedIds.length})
            </Button>
          </div>
        </div>

        <div className="no-print grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard
            testId="stat-employees"
            label="Active employees"
            value={employeesLoading ? "-" : summary.total}
            sub={employeesLoading ? undefined : `${summary.staff} staff · ${summary.production} production`}
            icon={Users}
            tone="bg-slate-100 text-slate-800"
          />
          <StatCard
            testId="stat-photos"
            label="Photos on file"
            value={employeesLoading ? "-" : `${summary.withPhoto} of ${summary.total}`}
            sub={
              employeesLoading
                ? undefined
                : summary.withoutPhoto === 0
                  ? "every card has a photo"
                  : `${summary.withoutPhoto} would print without one`
            }
            icon={Camera}
            tone={
              !employeesLoading && summary.withoutPhoto > 0
                ? "bg-amber-50 text-amber-800"
                : "bg-green-50 text-green-800"
            }
          />
          <StatCard
            testId="stat-complete"
            label="Ready to print"
            value={employeesLoading ? "-" : summary.complete}
            sub={employeesLoading ? undefined : `${summary.incomplete} miss a photo, blood group or contact`}
            icon={CheckCircle2}
            tone="bg-blue-50 text-blue-800"
          />
          <StatCard
            testId="stat-selected"
            label="Selected"
            value={selection.count}
            sub={
              selection.count === 0
                ? "tick employees on the left"
                : `${selection.staff} staff · ${selection.production} production`
            }
            icon={CreditCard}
            tone="bg-teal-50 text-teal-800"
          />
        </div>

        <div className="grid items-start gap-4 lg:grid-cols-[340px_1fr]">
          <EmployeePicker
            employees={employees}
            loading={employeesLoading}
            error={employeesError}
            onRetry={() => refetch()}
            selectedIds={selectedIds}
            onSelect={setSelectedIds}
          />

          {/* ── Card previews ── */}
          <div className="print-area min-w-0">
            {selectedIds.length === 0 ? (
              <Card className="no-print rounded-2xl border" data-testid="id-preview-empty">
                <CardContent className="py-20 text-center">
                  <CreditCard size={40} className="mx-auto mb-3 text-gray-200" />
                  <p className="text-sm text-gray-500">Select employees on the left to generate their ID cards.</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Staff cards are vertical with photo · production cards are horizontal.
                  </p>
                </CardContent>
              </Card>
            ) : cardsError && cards.length === 0 ? (
              <div
                className="no-print flex flex-col items-center gap-3 rounded-2xl border bg-white px-6 py-14 text-center"
                data-testid="id-cards-error"
              >
                <AlertTriangle size={26} className="text-red-500" />
                <p className="font-bold text-gray-900">The ID cards could not be loaded</p>
                <Button variant="outline" onClick={() => refetchCards()} className="gap-1.5">
                  <RefreshCw size={14} /> Retry
                </Button>
              </div>
            ) : cardsLoading && cards.length === 0 ? (
              <CircleLoader texts={["UK Textiles", "ID Cards", "Loading"]} className="w-full" />
            ) : (
              <div className="space-y-6">
                {selection.noPhoto.length > 0 && (
                  <div
                    className="no-print flex flex-wrap items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"
                    data-testid="id-photo-warning"
                  >
                    <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                    <p className="min-w-0 flex-1">
                      <b>
                        {selection.noPhoto.length} selected{" "}
                        {selection.noPhoto.length === 1 ? "employee has" : "employees have"} no photo
                      </b>{" "}
                      and will print an empty silhouette:{" "}
                      {selection.noPhoto
                        .slice(0, 4)
                        .map((e) => e.firstName)
                        .join(", ")}
                      {selection.noPhoto.length > 4 && ` and ${selection.noPhoto.length - 4} more`}.
                    </p>
                    <button
                      type="button"
                      className="font-semibold underline"
                      onClick={() =>
                        setSelectedIds((ids) =>
                          removeIds(
                            ids,
                            selection.noPhoto.map((e) => e.id),
                          ),
                        )
                      }
                      data-testid="id-deselect-no-photo"
                    >
                      Deselect them
                    </button>
                  </div>
                )}
                {cardsFetching && (
                  <p className="no-print text-xs text-muted-foreground" data-testid="id-cards-updating">
                    Updating the cards…
                  </p>
                )}
                {cards.map((card) => (
                  <CardPreview
                    key={card.id}
                    card={card}
                    qr={qrs[card.code]}
                    cardRef={(el) => {
                      cardRefs.current[card.id] = el;
                    }}
                    emailBusy={emailMutation.isPending}
                    whatsappBusy={whatsappMutation.isPending}
                    downloadBusy={busy}
                    onEmail={() => handleEmail(card)}
                    onWhatsApp={() => handleWhatsApp(card)}
                    onDownload={() => handleDownloadOne(card)}
                    onRemove={() => setSelectedIds((ids) => toggleId(ids, card.id))}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </HrLayout>
  );
}
