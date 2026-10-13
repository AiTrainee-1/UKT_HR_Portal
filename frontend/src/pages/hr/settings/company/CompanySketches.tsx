import { isHexColour } from "../identity/colours";

// Small drawings of the places outside the PDFs where the Company tab's details show, drawn the way the real screens
// draw them (sizes and colours copied from the components named on each), from the values being typed.

/** Header of the HR portal's left menu (components/ui/dashboard-sidebar.tsx). */
export function SidebarSketch({ name, logo }: { name: string; logo: string | null }) {
  return (
    <div
      className="flex items-center gap-3 rounded-xl px-4 py-3"
      style={{ background: "#f6fafe", borderBottom: "1px solid rgba(0,100,150,0.08)" }}
      data-testid="sketch-sidebar"
    >
      {logo ? (
        <img src={logo} alt="" className="h-9 w-9 shrink-0 rounded-full bg-white object-contain" />
      ) : (
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#4FB8F0] text-[10px] font-black text-white">
          UKT
        </span>
      )}
      <div className="min-w-0">
        <p className="truncate text-[15px] font-black leading-none tracking-tight" style={{ color: "#006496" }}>
          {name}
        </p>
        <p
          className="mt-0.5 text-[10px] font-semibold uppercase leading-none tracking-widest"
          style={{ color: "#006496", opacity: 0.45 }}
        >
          HR Portal
        </p>
      </div>
    </div>
  );
}

/** First rows of a Report Center export (reporting/export_xlsx.py / export_pdf.py letterhead). */
export function ReportHeaderSketch({
  name,
  subLine,
  logo,
  excel,
}: {
  name: string;
  subLine: string;
  logo: string | null;
  excel?: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white" data-testid="sketch-report">
      <div className="flex items-center gap-2 px-2.5 pt-2">
        {logo && <img src={logo} alt="" className="h-8 w-8 shrink-0 object-contain" />}
        <div className="min-w-0">
          <p className="truncate text-[13px] font-bold text-[#0d2a38]">{name}</p>
          <p className="truncate text-[10px] text-gray-500">
            {subLine || <span className="italic text-gray-400">(no second line)</span>}
          </p>
        </div>
      </div>
      <p className="mt-1.5 bg-[#006496] px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-white">
        {excel ? "Monthly attendance register (Excel)" : "Monthly attendance register (PDF)"}
      </p>
    </div>
  );
}

/** Company band at the top of an ID card (components/idcard/IdCardViews.tsx CompanyHeader). */
export function IdCardHeaderSketch({
  name,
  address,
  logo,
  primary,
  secondary,
}: {
  name: string;
  address: string;
  logo: string | null;
  primary: string;
  secondary: string;
}) {
  const p = isHexColour(primary) ? primary : "#006496";
  const s = isHexColour(secondary) ? secondary : "#4FB8F0";
  return (
    <div
      className="flex w-[240px] max-w-full items-center gap-2 rounded-t-2xl px-3 py-3"
      style={{ background: `linear-gradient(120deg, ${p}, ${s})` }}
      data-testid="sketch-idcard-header"
    >
      {logo ? (
        <img src={logo} alt="" className="h-8 w-8 shrink-0 rounded-full bg-white object-contain p-0.5" />
      ) : (
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white">
          <span className="text-[10px] font-black" style={{ color: p }}>
            UK
          </span>
        </span>
      )}
      <div className="min-w-0 text-white">
        <p className="truncate text-[13px] font-black leading-tight">{name || " "}</p>
        <p className="truncate text-[8px] leading-tight opacity-90">{address || " "}</p>
      </div>
    </div>
  );
}
