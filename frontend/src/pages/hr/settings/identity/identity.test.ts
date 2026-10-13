import { describe, expect, it } from "vitest";
import { contrastRatio, isHexColour, toPickerHex, withAlpha } from "./colours";
import {
  documentContactLine,
  emailCompanyName,
  footerNote,
  idCardCompany,
  letterheadContactLines,
  letterheadName,
  reportLetterhead,
  sidebarName,
  slipHeader,
  verifyPageCompany,
  type CompanyValues,
} from "./company-outputs";
import { logoDistortion } from "./images";
import { A4_WIDTH_PT, FOOTER_LINES, FOOTER_ROOM_PT, lineFit, textWidthPt, watermarkFits, wrapText } from "./pdf-text";
import { changedKeys } from "./useDraft";

const COMPANY: CompanyValues = {
  companyName: "UKTextiles",
  companyAddress: "12, Kumaran Road, Tirupur - 641601",
  companyPhone: "0421 2234500",
  companyEmail: "hr@uktextiles.example",
  companyWebsite: "www.uktextiles.example",
  companyGstin: "33AAAAA0000A1Z5",
  companyTagline: "Garments Manufacturing Excellence",
};

describe("PDF text widths (reportlab's own numbers)", () => {
  it("measures like reportlab's pdfmetrics.stringWidth", () => {
    // reportlab: stringWidth("Weaving Quality. Building Trust.", "Times-Italic", 1000) = 13306 -> 139.7 pt at 10.5 pt.
    expect(textWidthPt("Weaving Quality. Building Trust.", "serifItalic", 10.5)).toBeCloseTo(139.71, 1);
    // Helvetica 16341 / Arial 16342.8 per 1000 pt for the sample address.
    expect(textWidthPt("12, Kumaran Road, Tirupur - 641601", "body", 1000)).toBeCloseTo(16343, -1);
    expect(textWidthPt("UKTEXTILES", "serifBold", 66)).toBeCloseTo(465.3, 1);
  });

  it("says whether a footer line fits inside the page border, and roughly how much is too much", () => {
    expect(Math.round(FOOTER_ROOM_PT)).toBe(544);
    const short = lineFit("Weaving Quality. Building Trust.", FOOTER_LINES.tagline.font, FOOTER_LINES.tagline.sizePt);
    expect(short).toMatchObject({ fits: true, offPaper: false, charsOver: 0 });
    const long = lineFit("Weaving Quality. ".repeat(9), FOOTER_LINES.tagline.font, FOOTER_LINES.tagline.sizePt);
    expect(long.fits).toBe(false);
    expect(long.widthPt).toBeGreaterThan(A4_WIDTH_PT);
    expect(long.offPaper).toBe(true);
    expect(long.charsOver).toBeGreaterThan(0);
  });

  it("counts unknown characters as a full em, so another script is never wrongly said to fit", () => {
    expect(textWidthPt("அ", "body", 10)).toBe(10);
    expect(textWidthPt("•", "body", 1000)).toBe(350);
  });

  it("wraps a heading at spaces within the column width", () => {
    expect(wrapText("UK TEXTILES PRIVATE LIMITED", "serifBold", 15, 150)).toEqual(["UK TEXTILES", "PRIVATE LIMITED"]);
    expect(wrapText("UKTEXTILES", "serifBold", 15, 300)).toEqual(["UKTEXTILES"]);
  });

  it("knows when the 66 pt diagonal watermark no longer fits across the page", () => {
    expect(watermarkFits("UKTextiles")).toBe(true);
    expect(watermarkFits("UK Textiles Private Limited")).toBe(false);
  });
});

describe("what prints where (the backend's fallbacks)", () => {
  it("letterhead, sidebar and email names fall back the way their code does", () => {
    expect(letterheadName("UKTextiles")).toBe("UKTEXTILES");
    expect(letterheadName("  ")).toBe("UK TEXTILES");
    expect(sidebarName("")).toBe("UKTextiles");
    expect(emailCompanyName("", "UK TEXTILES - H.O")).toBe("UK TEXTILES - H.O");
    expect(emailCompanyName("", "")).toBe("UKTextiles");
  });

  it("the salary slip header uses the Salary Slip tab name, the address has no fallback", () => {
    expect(slipHeader({ slipCompanyName: "UK Textiles - H.O", slipCompanyAddress: "" }, "UKTextiles")).toEqual({
      name: "UK TEXTILES - H.O",
      address: "",
    });
    expect(slipHeader({ slipCompanyName: "", slipCompanyAddress: "TIRUPUR" }, "UKTextiles").name).toBe("UKTEXTILES");
    expect(verifyPageCompany({ slipCompanyName: "UK TEXTILES - H.O", slipCompanyAddress: "TIRUPUR" })).toEqual({
      name: "UK TEXTILES - H.O",
      address: "TIRUPUR",
    });
  });

  it("an ID card names the Company tab's company, else the Salary Slip tab's", () => {
    const slip = { slipCompanyName: "UK TEXTILES - H.O", slipCompanyAddress: "TIRUPUR" };
    expect(idCardCompany(COMPANY, slip)).toEqual({ name: "UKTextiles", address: COMPANY.companyAddress });
    expect(idCardCompany({ companyName: "", companyAddress: "" }, slip)).toEqual({
      name: "UK TEXTILES - H.O",
      address: "TIRUPUR",
    });
  });

  it("builds the footer contact line, letterhead column and footer notes", () => {
    expect(documentContactLine(COMPANY)).toBe(
      "12, Kumaran Road, Tirupur - 641601   •   0421 2234500   •   hr@uktextiles.example   •   www.uktextiles.example",
    );
    expect(documentContactLine({ ...COMPANY, companyPhone: " ", companyEmail: "" })).toBe(
      "12, Kumaran Road, Tirupur - 641601   •   www.uktextiles.example",
    );
    expect(letterheadContactLines(COMPANY)).toEqual([
      "www.uktextiles.example",
      "hr@uktextiles.example",
      "0421 2234500",
    ]);
    expect(footerNote("offer_letter", "")).toBe(
      "This is a system-generated offer letter from the UK Textiles HR Portal.",
    );
    expect(footerNote("salary_slip", "UKTextiles", "SAMPLE-PREVIEW")).toBe("System-generated payslip -SAMPLE-PREVIEW");
  });

  it("report letterheads join address, contacts and GSTIN; Excel falls back to the tagline", () => {
    const r = reportLetterhead(COMPANY);
    expect(r.pdfSubLine).toBe(
      "12, Kumaran Road, Tirupur - 641601  |  0421 2234500  |  hr@uktextiles.example  |  www.uktextiles.example  |  GSTIN 33AAAAA0000A1Z5",
    );
    const blank = reportLetterhead({
      ...COMPANY,
      companyAddress: "",
      companyPhone: "",
      companyEmail: "",
      companyWebsite: "",
      companyGstin: "",
    });
    expect(blank).toEqual({ name: "UKTextiles", pdfSubLine: "", excelSubLine: "Garments Manufacturing Excellence" });
  });
});

describe("colours", () => {
  it("accepts only #RRGGBB (reportlab reads #abc as 0x000abc)", () => {
    expect(isHexColour("#0E4B3A")).toBe(true);
    expect(isHexColour(" #0e4b3a ")).toBe(true);
    expect(isHexColour("#abc")).toBe(false);
    expect(isHexColour("0E4B3A")).toBe(false);
    expect(toPickerHex("#abc")).toBe("#aabbcc");
    expect(toPickerHex("nope", "#123456")).toBe("#123456");
  });

  it("works out WCAG contrast and alpha tints", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#006496", "#ffffff")).toBeGreaterThan(4.5);
    expect(withAlpha("#0E4B3A", 0.5)).toBe("#0e4b3a80");
  });
});

describe("logo box", () => {
  it("measures how much the fixed 2.6 x 1.5 cm box distorts a logo", () => {
    expect(logoDistortion(260, 150)).toBeCloseTo(1, 5);
    expect(logoDistortion(500, 500)).toBeCloseTo(2.6 / 1.5, 5);
    expect(logoDistortion(0, 10)).toBe(1);
  });
});

describe("draft edits", () => {
  it("only counts a field as changed when its value really differs (text compared trimmed)", () => {
    const saved = { name: "UKTextiles", logo: null as string | null, rate: 0 };
    expect(changedKeys(saved, { name: "UKTextiles " })).toEqual([]);
    expect(changedKeys(saved, { name: "UK Tex", logo: null, rate: 0 })).toEqual(["name"]);
    expect(changedKeys(saved, { logo: "data:image/png;base64,AA" })).toEqual(["logo"]);
  });
});
