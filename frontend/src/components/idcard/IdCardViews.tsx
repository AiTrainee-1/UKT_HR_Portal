import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { User, Droplets, Phone, MapPin, Cake, BadgeCheck, Briefcase } from "lucide-react";
import type { IdCardData } from "@/lib/api-client/custom-hooks";

function formatJoinDate(joinDate?: string | null): string {
  if (!joinDate) return "—";
  const d = new Date(joinDate);
  if (isNaN(d.getTime())) return joinDate;
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

// ── Default brand colours (used when no ID Card template is configured) ────
export const BRAND = "#4FB8F0";
export const BRAND_DARK = "#006496";

function colorsFor(card: IdCardData) {
  return {
    primary: card.template?.primaryColor || BRAND_DARK,
    secondary: card.template?.secondaryColor || BRAND,
    text: card.template?.textColor || "#0f172a",
    font: card.template?.fontFamily || "Hanken Grotesk",
    rounded: (card.template?.cornerStyle ?? "rounded") !== "sharp",
    showQr: card.template?.showQrOnBack ?? true,
    footerText: card.template?.footerText || "",
    bgStyle: card.template?.backgroundStyle || "gradient",
    logoCenter: (card.template?.logoPosition || "left") === "center",
  };
}

/** Header background per the template's Background Style setting. */
function headerBackground(bgStyle: string, primary: string, secondary: string): string {
  if (bgStyle === "solid") return primary;
  if (bgStyle === "pattern") {
    return `radial-gradient(rgba(255,255,255,0.18) 1px, transparent 1px) 0 0 / 8px 8px, linear-gradient(120deg, ${primary}, ${secondary})`;
  }
  return `linear-gradient(120deg, ${primary}, ${secondary})`;
}

export function useQrCodes(cards: IdCardData[]) {
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

function CompanyHeader({ card, compact }: { card: IdCardData; compact?: boolean }) {
  const { primary, secondary, bgStyle, logoCenter } = colorsFor(card);
  return (
    <div
      className={`flex items-center gap-2 px-3 ${logoCenter ? "flex-col justify-center text-center gap-1" : ""}`}
      style={{
        background: headerBackground(bgStyle, primary, secondary),
        paddingTop: compact ? 8 : 12,
        paddingBottom: compact ? 8 : 12,
      }}
    >
      {card.company.logo ? (
        <img src={card.company.logo} alt="" className="h-8 w-8 object-contain bg-white rounded-full p-0.5 shrink-0" />
      ) : (
        <div className="h-8 w-8 rounded-full bg-white flex items-center justify-center shrink-0">
          <span className="text-[10px] font-black" style={{ color: primary }}>UK</span>
        </div>
      )}
      <div className={`min-w-0 text-white ${logoCenter ? "text-center" : ""}`}>
        <p className="font-black leading-tight truncate" style={{ fontSize: compact ? 11 : 13 }}>
          {card.company.name}
        </p>
        <p className="text-[8px] opacity-90 leading-tight truncate">{card.company.address}</p>
      </div>
    </div>
  );
}

export function StaffCardFront({ card }: { card: IdCardData }) {
  const { primary, secondary, text, font, rounded } = colorsFor(card);
  return (
    <div
      className={`idcard w-[240px] h-[380px] bg-white overflow-hidden shadow-xl border flex flex-col shrink-0 relative ${rounded ? "rounded-2xl" : "rounded-none"}`}
      style={{ fontFamily: font }}
    >
      {/* Subtle watermark pattern */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.04]"
        style={{
          backgroundImage: `radial-gradient(${primary} 1px, transparent 1px)`,
          backgroundSize: "10px 10px",
        }}
      />

      <div className="relative z-10 flex flex-col h-full">
        <CompanyHeader card={card} />

        <div className="flex items-center justify-center gap-1.5 py-1.5" style={{ background: "#eaf6fd" }}>
          <BadgeCheck size={10} style={{ color: primary }} />
          <p className="text-[8px] font-black tracking-[0.2em] uppercase" style={{ color: primary }}>
            Employee Identity Card
          </p>
        </div>

        <div className="flex-1 flex flex-col items-center px-4 pt-4">
          <div
            className={`w-24 h-28 overflow-hidden border-[3px] flex items-center justify-center bg-gray-50 shadow-md ${rounded ? "rounded-xl" : "rounded-none"}`}
            style={{ borderColor: secondary, boxShadow: `0 3px 10px ${secondary}55` }}
          >
            {card.photoUrl
              ? <img src={card.photoUrl} className="w-full h-full object-cover" alt="" />
              : <User size={38} className="text-gray-300" />}
          </div>

          <p className="mt-3 font-black text-[15px] text-center leading-tight" style={{ color: text }}>{card.name}</p>

          <div
            className="flex items-center gap-1 mt-1 px-2.5 py-0.5 rounded-full"
            style={{ background: `${primary}14` }}
          >
            <Briefcase size={9} style={{ color: primary }} />
            <p className="text-[9px] font-bold" style={{ color: primary }}>{card.designation ?? "Staff"}</p>
          </div>

          {/* Highlighted employee-code strip */}
          <div
            className="w-full mt-3 rounded-lg py-1.5 text-center"
            style={{ background: `linear-gradient(90deg, ${primary}, ${secondary})` }}
          >
            <p className="text-[7px] tracking-[0.15em] uppercase text-white/80 font-semibold leading-none">Employee Code</p>
            <p className="text-[13px] font-black text-white font-mono leading-tight mt-0.5">{card.code}</p>
          </div>

          <div className="w-full mt-2.5 space-y-1 text-[9px]">
            {[
              ["Department", card.department ?? "—"],
              ["Branch", card.unitCode ?? card.branchCode ?? card.branchName ?? "—"],
              ["Joined Date", formatJoinDate(card.joinDate)],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between border-b border-dashed border-gray-200 pb-0.5">
                <span className="text-gray-400 font-semibold">{k}</span>
                <span className="font-bold font-mono" style={{ color: text }}>{v}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="h-3" style={{ background: `linear-gradient(90deg, ${primary}, ${secondary}, ${primary})` }} />
      </div>
    </div>
  );
}

export function StaffCardBack({ card, qr }: { card: IdCardData; qr?: string }) {
  const { primary, secondary, font, rounded, showQr, footerText } = colorsFor(card);
  return (
    <div className={`idcard w-[240px] h-[380px] bg-white overflow-hidden shadow-lg border flex flex-col shrink-0 ${rounded ? "rounded-2xl" : "rounded-none"}`} style={{ fontFamily: font }}>
      <div className="h-2.5" style={{ background: `linear-gradient(90deg, ${secondary}, ${primary})` }} />
      <div className="flex-1 px-4 pt-3 space-y-2">
        <div className="space-y-1 text-[9px]">
          {[
            { icon: Droplets, k: "Blood Group", v: card.bloodGroup ?? "—" },
            { icon: Cake, k: "Date of Birth", v: card.dateOfBirth ?? "—" },
            { icon: Phone, k: "Emergency", v: card.emergencyContact ?? card.phone ?? "—" },
          ].map(({ icon: Icon, k, v }) => (
            <div key={k} className="flex items-center gap-1.5 border-b border-dashed border-gray-200 pb-1">
              <Icon size={9} style={{ color: primary }} className="shrink-0" />
              <span className="text-gray-400 font-semibold">{k}</span>
              <span className="ml-auto font-bold text-gray-900 text-right">{v}</span>
            </div>
          ))}
          <div className="flex items-start gap-1.5 pb-0.5">
            <MapPin size={9} style={{ color: primary }} className="shrink-0 mt-0.5" />
            <span className="text-gray-400 font-semibold shrink-0">Address</span>
            <span className="ml-auto font-semibold text-gray-800 text-right leading-tight line-clamp-3">
              {card.address ?? "—"}
            </span>
          </div>
        </div>

        {showQr && (
          <div className="flex flex-col items-center pt-0.5">
            {qr ? <img src={qr} className="w-20 h-20" alt="QR" /> : <div className="w-20 h-20 bg-gray-100 rounded" />}
            <p className="text-[7px] text-gray-400 font-semibold mt-0.5">SCAN TO VERIFY EMPLOYEE</p>
          </div>
        )}

        <div className="text-[7px] text-gray-500 leading-snug">
          <p className="font-bold text-gray-600 mb-0.5">INSTRUCTIONS</p>
          <p>• This card must be worn visibly inside company premises.</p>
          <p>• Card is company property — return on exit/resignation.</p>
          <p>• If found, please return to {card.company.name}, {card.company.address}.</p>
          {footerText && <p className="italic">{footerText}</p>}
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

export function ProductionCardFront({ card }: { card: IdCardData }) {
  const { primary, secondary, text, font, rounded } = colorsFor(card);
  return (
    <div className={`idcard w-[380px] h-[240px] bg-white overflow-hidden shadow-lg border flex flex-col shrink-0 ${rounded ? "rounded-2xl" : "rounded-none"}`} style={{ fontFamily: font }}>
      <CompanyHeader card={card} compact />
      <div className="text-center py-1" style={{ background: "#eaf6fd" }}>
        <p className="text-[8px] font-black tracking-[0.2em] uppercase" style={{ color: primary }}>
          Employee Identity Card — Production
        </p>
      </div>
      <div className="flex-1 flex items-center gap-3 px-4">
        <div
          className={`w-20 h-24 overflow-hidden border-4 flex items-center justify-center bg-gray-50 shrink-0 ${rounded ? "rounded-xl" : "rounded-none"}`}
          style={{ borderColor: secondary }}
        >
          {card.photoUrl
            ? <img src={card.photoUrl} className="w-full h-full object-cover" alt="" />
            : <User size={30} className="text-gray-300" />}
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-black text-[15px] leading-tight truncate" style={{ color: text }}>{card.name}</p>
          <p className="text-[10px] font-bold mb-1.5" style={{ color: primary }}>{card.designation ?? "Employee"}</p>
          <div className="space-y-0.5 text-[9px]">
            {[
              ["Emp Code", card.code],
              ["Department", card.department ?? "—"],
              ["Branch", card.unitCode ?? card.branchCode ?? card.branchName ?? "—"],
              ["Joined Date", formatJoinDate(card.joinDate)],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between border-b border-dashed border-gray-200 pb-0.5">
                <span className="text-gray-400 font-semibold">{k}</span>
                <span className="font-bold font-mono" style={{ color: text }}>{v}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="h-2.5" style={{ background: `linear-gradient(90deg, ${primary}, ${secondary})` }} />
    </div>
  );
}

export function ProductionCardBack({ card, qr }: { card: IdCardData; qr?: string }) {
  const { primary, secondary, font, rounded, showQr, footerText } = colorsFor(card);
  return (
    <div className={`idcard w-[380px] h-[240px] bg-white overflow-hidden shadow-lg border flex flex-col shrink-0 ${rounded ? "rounded-2xl" : "rounded-none"}`} style={{ fontFamily: font }}>
      <div className="h-2.5" style={{ background: `linear-gradient(90deg, ${secondary}, ${primary})` }} />
      <div className="flex-1 flex gap-3 px-4 pt-2.5">
        <div className="flex-1 space-y-1 text-[9px]">
          {[
            { icon: Droplets, k: "Blood Group", v: card.bloodGroup ?? "—" },
            { icon: Cake, k: "Date of Birth", v: card.dateOfBirth ?? "—" },
            { icon: Phone, k: "Emergency", v: card.emergencyContact ?? card.phone ?? "—" },
          ].map(({ icon: Icon, k, v }) => (
            <div key={k} className="flex items-center gap-1.5 border-b border-dashed border-gray-200 pb-1">
              <Icon size={9} style={{ color: primary }} className="shrink-0" />
              <span className="text-gray-400 font-semibold">{k}</span>
              <span className="ml-auto font-bold text-gray-900">{v}</span>
            </div>
          ))}
          <div className="flex items-start gap-1.5">
            <MapPin size={9} style={{ color: primary }} className="shrink-0 mt-0.5" />
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
            {footerText && <p className="italic">{footerText}</p>}
          </div>
        </div>
        <div className="flex flex-col items-center justify-center shrink-0">
          {showQr && (
            <>
              {qr ? <img src={qr} className="w-24 h-24" alt="QR" /> : <div className="w-24 h-24 bg-gray-100 rounded" />}
              <p className="text-[7px] text-gray-400 font-semibold mt-1">SCAN TO VERIFY</p>
            </>
          )}
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
