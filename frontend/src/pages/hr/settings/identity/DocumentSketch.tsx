import { useId } from "react";
import { DOCUMENT_TITLES, type DocType } from "./company-outputs";
import { isHexColour } from "./colours";
import {
  A4_HEIGHT_PT as H,
  A4_WIDTH_PT as W,
  CM_PT as CM,
  FOOTER_LINES,
  PAGE_BORDER_PT,
  WATERMARK,
  textWidthPt,
  wrapText,
  type PdfFont,
} from "./pdf-text";

// A small drawing of one A4 page of a company document, laid out in PDF points the way document_pdf.py and
// company_documents_views.py lay it out (frame, letterhead table, title, footer band), so proportions are right: a logo
// is stretched into its fixed 2.6 x 1.5 cm box exactly as the PDF stretches it, and a footer line wider than the
// paper is cut at the edges just as it is when printed. Body text is drawn as grey bars; only the parts the Settings
// page controls are drawn as text.

export type SketchPart =
  | "logo"
  | "name"
  | "address"
  | "contacts"
  | "title"
  | "watermark"
  | "tagline"
  | "contactLine"
  | "note"
  | "badge"
  | "minWage"
  | "signature"
  | "page";

export type DocumentSketchProps = {
  doc: DocType;
  primary: string;
  accent: string;
  headingStyle: "serif" | "sans";
  logo: string | null;
  /** The name as printed (letters and slips print it in capitals). */
  name: string;
  /** Line under the name; "" prints nothing. */
  address: string;
  /** Letters: the right-hand column (website, email, phone). */
  contacts?: string[];
  /** Watermark text, or null when it is switched off. */
  watermark: string | null;
  tagline: string;
  contactLine: string;
  note: string;
  /** Letters: the authorised signature; salary slip: the employer signature. */
  signature?: string | null;
  /** Salary slip: the Minimum Rate of Wages printed in the personal-details block. */
  minWage?: string;
  /** Parts to ring in amber (what the setting next to the drawing changes). */
  highlight?: SketchPart[];
  /** Width of the drawing in screen pixels. */
  width?: number;
  /** Draw only the strip of the page around this part (the header, the footer band, one row), not the whole page. */
  crop?: SketchPart;
  label: string;
};

const HEADER_PARTS: SketchPart[] = ["logo", "name", "address", "contacts", "title", "badge"];
const FOOTER_PARTS: SketchPart[] = ["tagline", "contactLine", "note"];

/** The top and bottom (in points) of the strip of the page a cut-out shows. */
function cropRange(part: SketchPart | undefined, boxes: Partial<Record<SketchPart, Box>>, rule: number) {
  if (!part || part === "page" || part === "watermark") return [0, H];
  if (HEADER_PARTS.includes(part)) return [0, rule + 14];
  if (FOOTER_PARTS.includes(part)) return [H - FOOTER_H - WAVE - 10, H];
  const b = boxes[part];
  if (!b) return [0, H];
  return [Math.max(0, b.y - 34), Math.min(H, b.y + b.h + 24)];
}

type Box = { x: number; y: number; w: number; h: number };

const L = 1.5 * CM; // frame left / right margin
const T = 1.35 * CM; // frame top margin
const CW = W - 2 * L; // frame width
const PAD = 6; // reportlab's default table cell padding (left / right)
const FOOTER_H = 2.5 * CM;
const WAVE = 0.45 * CM;
const LOGO_W = 2.6 * CM;
const LOGO_H = 1.5 * CM;

const FONT_FAMILY = {
  serif: "Georgia, 'Times New Roman', serif",
  sans: "Arial, Helvetica, sans-serif",
  italic: "'Times New Roman', Times, serif",
} as const;

const GREY_LINE = "#e5e7eb";

/** Where the header parts of a page go, in points from the top-left corner. */
export function headerLayout(
  p: Pick<DocumentSketchProps, "doc" | "logo" | "name" | "address" | "contacts" | "headingStyle">,
) {
  const slip = p.doc === "salary_slip";
  const headingFont: PdfFont = p.headingStyle === "sans" ? "bodyBold" : "serifBold";
  const leftInner = (slip ? 10 * CM : 11 * CM) - 2 * PAD;
  const x = L + PAD;
  let y = T + 3;
  const logo: Box | null = p.logo ? { x, y, w: LOGO_W, h: LOGO_H } : null;
  if (logo) y += LOGO_H + (slip ? 0 : 0.15 * CM);
  const nameLines = wrapText(p.name, headingFont, 15, leftInner);
  const name: Box = {
    x,
    y,
    w: Math.max(...nameLines.map((l) => textWidthPt(l, headingFont, 15)), 0),
    h: 18 * nameLines.length,
  };
  y += name.h;
  const addressLines = p.address ? wrapText(p.address, "body", 8.5, leftInner) : [];
  const address: Box = {
    x,
    y,
    w: Math.max(...addressLines.map((l) => textWidthPt(l, "body", 8.5)), 0),
    h: 10.2 * addressLines.length,
  };
  y += address.h;

  const rightEdge = L + (slip ? 10 * CM + 7.7 * CM : 11 * CM + 6.7 * CM) - PAD;
  const contacts = slip ? [] : (p.contacts ?? []);
  const contactsWidth = Math.max(...contacts.map((c) => textWidthPt(c, "body", 8)), 0);
  const contactsBox: Box = { x: rightEdge - contactsWidth, y: T + 3, w: contactsWidth, h: 12 * contacts.length };
  const rightBottom = slip ? T + 3 + 24 + 0.15 * CM + 0.8 * CM : contactsBox.y + contactsBox.h;
  const headerBottom = Math.max(y, rightBottom) + 3;
  const rule = headerBottom + (slip ? 0.3 * CM : 0.35 * CM);
  return { slip, headingFont, logo, nameLines, name, addressLines, address, rightEdge, contacts, contactsBox, rule };
}

function ringFor(part: SketchPart, boxes: Partial<Record<SketchPart, Box>>) {
  const b = boxes[part];
  if (!b) return null;
  return (
    <rect
      key={part}
      x={b.x - 4}
      y={b.y - 4}
      width={b.w + 8}
      height={b.h + 8}
      rx={4}
      fill="#f59e0b"
      fillOpacity={0.12}
      stroke="#d97706"
      strokeWidth={2.2}
      strokeDasharray="6 4"
      data-sketch-ring={part}
    />
  );
}

function centredBox(text: string, font: PdfFont, size: number, baseline: number): Box {
  const w = textWidthPt(text, font, size);
  return { x: W / 2 - w / 2, y: baseline - size, w, h: size * 1.3 };
}

const bars = (from: number, to: number, x: number, maxW: number, step = 13) => {
  const out: Box[] = [];
  let i = 0;
  for (let y = from; y < to; y += step, i++) {
    const w = i % 5 === 4 ? maxW * 0.55 : maxW * (0.86 + ((i * 7) % 10) / 100);
    out.push({ x, y, w: Math.min(w, maxW), h: 3.4 });
  }
  return out;
};

/** One A4 page of a company document, drawn from the settings being edited (not the saved ones). */
export function DocumentSketch(props: DocumentSketchProps) {
  const { doc, headingStyle, watermark, tagline, contactLine, note, signature, highlight = [], width = 300 } = props;
  const clipId = useId().replace(/:/g, "");
  const primary = isHexColour(props.primary) ? props.primary : "#0E4B3A";
  const accent = isHexColour(props.accent) ? props.accent : "#C9A227";
  const lay = headerLayout(props);
  const headingFamily = headingStyle === "sans" ? FONT_FAMILY.sans : FONT_FAMILY.serif;
  const title = DOCUMENT_TITLES[doc];

  const boxes: Partial<Record<SketchPart, Box>> = {
    name: lay.name,
    page: { x: 6, y: 6, w: W - 12, h: H - 12 },
  };
  if (lay.logo) boxes.logo = lay.logo;
  else boxes.logo = { x: L + PAD, y: T + 3, w: LOGO_W, h: LOGO_H };
  if (lay.addressLines.length) boxes.address = lay.address;
  if (lay.contacts.length) boxes.contacts = lay.contactsBox;

  // Footer band (PremiumPageDecorator.draw), in page coordinates (y down).
  const bandTop = H - FOOTER_H;
  const wave = `M0,${bandTop} C${W * 0.28},${bandTop - WAVE} ${W * 0.72},${bandTop + WAVE} ${W},${bandTop}`;
  const taglineY = H - (FOOTER_H - 0.85 * CM);
  const contactY = H - (FOOTER_H - 1.45 * CM);
  const noteY = H - (FOOTER_H - 1.95 * CM);
  if (tagline) boxes.tagline = centredBox(tagline, FOOTER_LINES.tagline.font, FOOTER_LINES.tagline.sizePt, taglineY);
  if (contactLine)
    boxes.contactLine = centredBox(contactLine, FOOTER_LINES.contact.font, FOOTER_LINES.contact.sizePt, contactY);
  if (note) boxes.note = centredBox(note, FOOTER_LINES.note.font, FOOTER_LINES.note.sizePt, noteY);

  // Title: letters centre it under the rule; the slip puts "SALARY SLIP" and the month badge on the right.
  const titleBaseline = lay.slip ? T + 3 + 17 : lay.rule + 0.8 + 0.3 * CM + 17;
  const titleX = lay.slip ? L + 10 * CM + PAD + (7.7 * CM - 2 * PAD) / 2 : W / 2;
  const titleW = textWidthPt(title, lay.headingFont, 19);
  boxes.title = { x: titleX - titleW / 2, y: titleBaseline - 17, w: titleW, h: 22 };
  const badge: Box = { x: lay.rightEdge - 5 * CM, y: T + 3 + 24 + 0.15 * CM, w: 5 * CM, h: 0.8 * CM };
  if (lay.slip) boxes.badge = badge;
  const bodyTop = lay.slip ? lay.rule + 0.3 * CM : titleBaseline + 7 + 0.5 * CM;

  // Watermark: centred, turned 35 degrees (reportlab's rotate is anticlockwise; SVG's is clockwise).
  const watermarkBox = watermark ? centredBox(watermark, WATERMARK.font, WATERMARK.sizePt, H / 2 + 22) : null;
  if (watermarkBox) boxes.watermark = watermarkBox;

  const slipGeom = slipGeometry(bodyTop);
  if (lay.slip) {
    boxes.minWage = { x: slipGeom.x0, y: slipGeom.personalTop + 2 * 14, w: 8.4 * CM, h: 14 };
    boxes.signature = { x: slipGeom.employerX, y: slipGeom.sigTop, w: 2.6 * CM, h: 1.2 * CM + 14 };
  } else {
    boxes.signature = { x: LETTER_SIG_X, y: LETTER_SIG_TOP, w: 3 * CM, h: 1.4 * CM + 26 };
  }

  // A cut-out of the page around one part (the header, the footer band, a row), or the whole page.
  const [cropTop, cropBottom] = cropRange(props.crop, boxes, lay.rule);

  return (
    <svg
      role="img"
      aria-label={props.label}
      viewBox={`0 ${cropTop} ${W} ${cropBottom - cropTop}`}
      width={width}
      height={(width * (cropBottom - cropTop)) / W}
      data-crop={props.crop ?? "page"}
      className="block rounded-md bg-white shadow-sm ring-1 ring-slate-200"
      data-testid="document-sketch"
      data-doc={doc}
    >
      <defs>
        <clipPath id={`page-${clipId}`}>
          <rect x={0} y={0} width={W} height={H} />
        </clipPath>
      </defs>
      <g clipPath={`url(#page-${clipId})`}>
        <rect x={0} y={0} width={W} height={H} fill="#ffffff" />

        {/* Double border with corner ticks, in the accent colour */}
        <rect
          x={PAGE_BORDER_PT}
          y={PAGE_BORDER_PT}
          width={W - 2 * PAGE_BORDER_PT}
          height={H - 2 * PAGE_BORDER_PT}
          fill="none"
          stroke={accent}
          strokeWidth={1.1}
        />
        <rect
          x={PAGE_BORDER_PT + 0.14 * CM}
          y={PAGE_BORDER_PT + 0.14 * CM}
          width={W - 2 * (PAGE_BORDER_PT + 0.14 * CM)}
          height={H - 2 * (PAGE_BORDER_PT + 0.14 * CM)}
          fill="none"
          stroke={accent}
          strokeWidth={0.4}
        />
        {[
          [PAGE_BORDER_PT, PAGE_BORDER_PT, 1, 1],
          [W - PAGE_BORDER_PT, PAGE_BORDER_PT, -1, 1],
          [PAGE_BORDER_PT, H - PAGE_BORDER_PT, 1, -1],
          [W - PAGE_BORDER_PT, H - PAGE_BORDER_PT, -1, -1],
        ].map(([x, y, dx, dy]) => (
          <path
            key={`${x}-${y}`}
            d={`M${x + dx * 0.6 * CM},${y} L${x},${y} L${x},${y + dy * 0.6 * CM}`}
            fill="none"
            stroke={accent}
            strokeWidth={1.8}
          />
        ))}

        {watermark && (
          <text
            x={W / 2}
            y={H / 2 + 22}
            textAnchor="middle"
            transform={`rotate(${-WATERMARK.angleDeg} ${W / 2} ${H / 2})`}
            fontFamily={FONT_FAMILY.serif}
            fontWeight={700}
            fontSize={WATERMARK.sizePt}
            fill={primary}
            fillOpacity={0.07}
            data-sketch="watermark"
          >
            {watermark}
          </text>
        )}

        {/* Letterhead / slip header */}
        {lay.logo && props.logo && (
          <image
            href={props.logo}
            x={lay.logo.x}
            y={lay.logo.y}
            width={lay.logo.w}
            height={lay.logo.h}
            preserveAspectRatio="none"
            data-sketch="logo"
          />
        )}
        {lay.nameLines.map((line, i) => (
          <text
            key={i}
            x={lay.name.x}
            y={lay.name.y + 13.5 + 18 * i}
            fontFamily={headingFamily}
            fontWeight={700}
            fontSize={15}
            fill={primary}
            data-sketch="name"
          >
            {line}
          </text>
        ))}
        {lay.addressLines.map((line, i) => (
          <text
            key={i}
            x={lay.address.x}
            y={lay.address.y + 7.6 + 10.2 * i}
            fontFamily={FONT_FAMILY.sans}
            fontSize={8.5}
            fill="#808080"
            data-sketch="address"
          >
            {line}
          </text>
        ))}
        {lay.contacts.map((line, i) => (
          <text
            key={i}
            x={lay.rightEdge}
            y={T + 3 + 7.2 + 12 * i}
            textAnchor="end"
            fontFamily={FONT_FAMILY.sans}
            fontSize={8}
            fill="#4b5563"
            data-sketch="contacts"
          >
            {line}
          </text>
        ))}
        <text
          x={titleX}
          y={titleBaseline}
          textAnchor="middle"
          fontFamily={headingFamily}
          fontWeight={700}
          fontSize={19}
          fill={primary}
          data-sketch="title"
        >
          {title}
        </text>
        {lay.slip ? (
          <g data-sketch="badge">
            <rect
              x={badge.x}
              y={badge.y}
              width={badge.w}
              height={badge.h}
              fill={primary}
              stroke={accent}
              strokeWidth={1}
            />
            <text
              x={badge.x + badge.w / 2}
              y={badge.y + badge.h / 2 + 3.5}
              textAnchor="middle"
              fontFamily={FONT_FAMILY.sans}
              fontWeight={700}
              fontSize={10}
              fill="#ffffff"
            >
              July 2026
            </text>
          </g>
        ) : (
          <rect x={W / 2 - 2.25 * CM} y={titleBaseline + 7} width={4.5 * CM} height={0.06 * CM} fill={accent} />
        )}
        <line x1={L} x2={L + CW} y1={lay.rule} y2={lay.rule} stroke={accent} strokeWidth={0.8} />

        {lay.slip ? (
          <SlipBody
            top={bodyTop}
            geom={slipGeom}
            primary={primary}
            accent={accent}
            signature={signature ?? null}
            minWage={props.minWage ?? ""}
          />
        ) : (
          <LetterBody
            top={bodyTop}
            primary={primary}
            headingFamily={headingFamily}
            signature={signature ?? null}
            doc={doc}
          />
        )}

        {/* Footer band with its accent curve and three centred lines */}
        <path d={`${wave} L${W},${H} L0,${H} Z`} fill={primary} />
        <path d={wave} fill="none" stroke={accent} strokeWidth={1.6} />
        {tagline && (
          <text
            x={W / 2}
            y={taglineY}
            textAnchor="middle"
            fontFamily={FONT_FAMILY.italic}
            fontStyle="italic"
            fontSize={FOOTER_LINES.tagline.sizePt}
            fill="#ffffff"
            data-sketch="tagline"
          >
            {tagline}
          </text>
        )}
        {contactLine && (
          <text
            x={W / 2}
            y={contactY}
            textAnchor="middle"
            fontFamily={FONT_FAMILY.sans}
            fontSize={FOOTER_LINES.contact.sizePt}
            fill="#ffffff"
            data-sketch="contactLine"
            xmlSpace="preserve"
          >
            {contactLine}
          </text>
        )}
        {note && (
          <text
            x={W / 2}
            y={noteY}
            textAnchor="middle"
            fontFamily={FONT_FAMILY.sans}
            fontSize={FOOTER_LINES.note.sizePt}
            fill="#ffffff"
            fillOpacity={0.75}
            data-sketch="note"
          >
            {note}
          </text>
        )}

        {highlight.map((part) => ringFor(part, boxes))}
      </g>
    </svg>
  );
}

/** Letters: the signature block sits at the right, a little above the footer band. */
const LETTER_SIG_TOP = 600;
const LETTER_SIG_X = L + 10.5 * CM + PAD;

/** Where the blocks of the single salary slip PDF go below its header (build_salary_slip_pdf, rounded). */
function slipGeometry(top: number) {
  const x0 = L + PAD;
  const rowH = 17.7;
  const tablesTop = top + 3 * 19 + 0.4 * CM;
  const personalTop = tablesTop + rowH * 10 + 0.4 * CM;
  const netTop = personalTop + 4 * 14 + 0.45 * CM;
  const sigTop = netTop + 50 + 0.5 * CM;
  return { x0, half: 8.6 * CM, rowH, tablesTop, personalTop, netTop, sigTop, employerX: x0 + 8.8 * CM };
}

function LetterBody({
  top,
  primary,
  headingFamily,
  signature,
  doc,
}: {
  top: number;
  primary: string;
  headingFamily: string;
  signature: string | null;
  doc: DocType;
}) {
  const sigTop = LETTER_SIG_TOP;
  const sigX = LETTER_SIG_X;
  return (
    <g>
      {bars(top, sigTop - 16, L + PAD, CW - 2 * PAD).map((b, i) => (
        <rect key={i} x={b.x} y={b.y} width={b.w} height={b.h} rx={1.5} fill={GREY_LINE} />
      ))}
      {signature && (
        <image
          href={signature}
          x={sigX}
          y={sigTop}
          width={3 * CM}
          height={1.4 * CM}
          preserveAspectRatio="none"
          data-sketch="signature"
        />
      )}
      <text
        x={sigX}
        y={sigTop + 1.4 * CM + 11}
        fontFamily={headingFamily}
        fontWeight={700}
        fontSize={10.5}
        fill={primary}
      >
        Authorized Signatory
      </text>
      <text x={sigX} y={sigTop + 1.4 * CM + 23} fontFamily={FONT_FAMILY.sans} fontSize={9} fill="#808080">
        {doc === "experience_letter" ? "Company Seal" : "HR Department"}
      </text>
    </g>
  );
}

function SlipBody({
  top,
  geom,
  primary,
  accent,
  signature,
  minWage,
}: {
  top: number;
  geom: ReturnType<typeof slipGeometry>;
  primary: string;
  accent: string;
  signature: string | null;
  minWage: string;
}) {
  const { x0, half, rowH, tablesTop, personalTop, netTop, sigTop, employerX } = geom;
  const infoRows = [
    ["Employee Code", "SAMPLE-001", "Employee Name", "Priya Sharma"],
    ["Designation", "Tailor", "Department", "Stitching"],
    ["Payroll Period", "July 2026", "Date of Joining", "15 January 2024"],
  ];
  const earn = [
    ["Basic Pay", "18,000.00"],
    ["HRA", "2,000.00"],
    ["Other Allowances", "1,500.00"],
    ["OT Wages", "500.00"],
    ["Total Earnings", "22,000.00"],
  ];
  const ded = [
    ["P.F", "2,160.00"],
    ["E.S.I", "165.00"],
    ["Advance", "0.00"],
    ["Other Deductions", "0.00"],
    ["Total Deductions", "2,325.00"],
  ];
  const personal = [
    ["Father's/Husband's Name", "Ganesan R"],
    ["No. of Shifts Worked", "26.0"],
    ["Minimum Rate of Wages", minWage || "₹0.00"],
    ["PF Number", "TN/12345/678"],
  ];
  const money = (rows: string[][], x: number, head: string, colour: string) => (
    <g>
      <rect x={x} y={tablesTop} width={7.7 * CM} height={rowH} fill={colour} />
      <text x={x + 5} y={tablesTop + 12} fontFamily={FONT_FAMILY.sans} fontWeight={700} fontSize={8.7} fill="#ffffff">
        {head}
      </text>
      {rows.map(([k, v], i) => (
        <g key={k}>
          <text
            x={x + 5}
            y={tablesTop + rowH * (i + 2) - 5}
            fontFamily={FONT_FAMILY.sans}
            fontSize={8.7}
            fill="#1f2937"
          >
            {k}
          </text>
          <text
            x={x + 7.7 * CM - 5}
            y={tablesTop + rowH * (i + 2) - 5}
            textAnchor="end"
            fontFamily={FONT_FAMILY.sans}
            fontSize={8.7}
            fill="#1f2937"
          >
            {"₹"}
            {v}
          </text>
        </g>
      ))}
      <rect x={x} y={tablesTop} width={7.7 * CM} height={rowH * 6} fill="none" stroke={GREY_LINE} strokeWidth={0.5} />
    </g>
  );
  return (
    <g>
      {infoRows.map((row, i) => (
        <g key={row[0]}>
          {row.map((cell, j) => (
            <text
              key={j}
              x={x0 + [0, 3.2, 8.5, 11.7][j] * CM}
              y={top + 19 * i + 12}
              fontFamily={FONT_FAMILY.sans}
              fontWeight={j % 2 === 0 ? 700 : 400}
              fontSize={9}
              fill={j % 2 === 0 ? primary : "#1f2937"}
            >
              {cell}
            </text>
          ))}
          <line
            x1={x0}
            x2={x0 + 17 * CM}
            y1={top + 19 * (i + 1)}
            y2={top + 19 * (i + 1)}
            stroke={GREY_LINE}
            strokeWidth={0.4}
          />
        </g>
      ))}
      {money(earn, x0, "Earnings", primary)}
      {money(ded, x0 + half, "Deductions", accent)}
      {personal.map(([k, v], i) => (
        <g key={k}>
          <text
            x={x0}
            y={personalTop + 14 * i + 10}
            fontFamily={FONT_FAMILY.sans}
            fontWeight={700}
            fontSize={8}
            fill="#4b5563"
          >
            {k}
          </text>
          <text
            x={x0 + 4.4 * CM}
            y={personalTop + 14 * i + 10}
            fontFamily={FONT_FAMILY.sans}
            fontSize={8}
            fill="#1f2937"
            data-sketch={k.startsWith("Minimum") ? "minWage" : undefined}
          >
            {v}
          </text>
        </g>
      ))}
      {bars(personalTop, personalTop + 4 * 14, x0 + half, 7.7 * CM, 14).map((b, i) => (
        <rect key={i} x={b.x} y={b.y + 4} width={b.w} height={b.h} rx={1.5} fill={GREY_LINE} />
      ))}
      <rect
        x={L + (CW - 17.2 * CM) / 2}
        y={netTop}
        width={17.2 * CM}
        height={31}
        fill={primary}
        stroke={accent}
        strokeWidth={1}
      />
      <text
        x={L + (CW - 17.2 * CM) / 2 + 10}
        y={netTop + 20}
        fontFamily={FONT_FAMILY.sans}
        fontWeight={700}
        fontSize={11}
        fill="#ffffff"
      >
        NET AMOUNT PAID
      </text>
      <text
        x={L + (CW + 17.2 * CM) / 2 - 10}
        y={netTop + 21}
        textAnchor="end"
        fontFamily={FONT_FAMILY.sans}
        fontWeight={700}
        fontSize={15}
        fill="#ffffff"
      >
        {"₹"}19,675.00
      </text>
      <rect
        x={L + (CW - 17.2 * CM) / 2}
        y={netTop + 31}
        width={17.2 * CM}
        height={18}
        fill="#f0f7f4"
        stroke={accent}
        strokeWidth={1}
      />
      <text x={x0} y={sigTop + 1.2 * CM + 10} fontFamily={FONT_FAMILY.sans} fontSize={9} fill="#808080">
        Employee Signature
      </text>
      {signature && (
        <image
          href={signature}
          x={employerX}
          y={sigTop}
          width={2.6 * CM}
          height={1.2 * CM}
          preserveAspectRatio="none"
          data-sketch="signature"
        />
      )}
      <text
        x={employerX}
        y={sigTop + 1.2 * CM + 10}
        fontFamily={FONT_FAMILY.sans}
        fontWeight={700}
        fontSize={9}
        fill="#808080"
      >
        Employer Signature
      </text>
    </g>
  );
}
