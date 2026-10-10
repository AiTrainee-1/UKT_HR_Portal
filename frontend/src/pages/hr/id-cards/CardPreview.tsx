import { Briefcase, CameraOff, Download, Factory, Mail, MessageCircle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { IdCardData } from "@/lib/api-client/custom-hooks";
import {
  ProductionCardBack,
  ProductionCardFront,
  StaffCardBack,
  StaffCardFront,
} from "@/components/idcard/IdCardViews";
import { GAP_LABEL, cardGaps } from "./logic";

type Props = {
  card: IdCardData;
  qr?: string;
  /** The element the card images are drawn from (download as a picture). */
  cardRef: (el: HTMLDivElement | null) => void;
  emailBusy: boolean;
  whatsappBusy: boolean;
  downloadBusy: boolean;
  onEmail: () => void;
  onWhatsApp: () => void;
  onDownload: () => void;
  onRemove: () => void;
};

/**
 * One employee's card, front and back, with its own actions above. Everything above the cards is `no-print`, and the
 * element holding the two cards is exactly what is printed and photographed: nothing is added inside it.
 */
export default function CardPreview({
  card,
  qr,
  cardRef,
  emailBusy,
  whatsappBusy,
  downloadBusy,
  onEmail,
  onWhatsApp,
  onDownload,
  onRemove,
}: Props) {
  const production = card.employmentType === "production";
  const gaps = cardGaps(card);
  return (
    <div className="space-y-2" data-testid={`id-card-${card.code}`}>
      <div className="no-print flex flex-wrap items-center gap-2">
        <p className="text-sm font-bold text-gray-800">
          {card.name} <span className="font-mono text-xs font-normal text-gray-400">({card.code})</span>
        </p>
        <span
          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
            production ? "border-orange-200 bg-orange-50 text-orange-700" : "border-blue-200 bg-blue-50 text-blue-700"
          }`}
        >
          {production ? <Factory size={10} /> : <Briefcase size={10} />}
          {production ? "Production · horizontal" : "Staff · vertical"}
        </span>
        {gaps.length > 0 && (
          <span
            className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-800"
            data-testid="card-gaps"
            title="These show as a blank or a dash on the printed card"
          >
            <CameraOff size={10} /> {gaps.map((g) => GAP_LABEL[g]).join(" · ")}
          </span>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 text-xs"
            onClick={onDownload}
            disabled={downloadBusy || !qr}
            title="Download this card as a picture"
            data-testid={`id-download-${card.code}`}
          >
            <Download size={11} /> Picture
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 text-xs"
            onClick={onEmail}
            disabled={emailBusy || !card.email}
            title={card.email ? `Email the card to ${card.email}` : "This employee has no email address"}
          >
            <Mail size={11} /> Email to employee
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 border-emerald-200 text-xs text-emerald-700 hover:bg-emerald-50"
            onClick={onWhatsApp}
            disabled={whatsappBusy || !card.phone}
            title={card.phone ? `Send the card on WhatsApp to ${card.phone}` : "This employee has no phone number"}
          >
            <MessageCircle size={11} /> Send via WhatsApp
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 text-gray-400 hover:text-red-600"
            onClick={onRemove}
            aria-label={`Remove ${card.name} from the selection`}
            title="Remove from the selection"
          >
            <X size={14} />
          </Button>
        </div>
      </div>
      <div ref={cardRef} className="flex flex-wrap gap-4">
        {production ? (
          <>
            <ProductionCardFront card={card} />
            <ProductionCardBack card={card} qr={qr} />
          </>
        ) : (
          <>
            <StaffCardFront card={card} />
            <StaffCardBack card={card} qr={qr} />
          </>
        )}
      </div>
    </div>
  );
}
