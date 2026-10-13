// What the portal actually prints from the Company and Salary Slip settings, with the same fallbacks the code that
// prints it uses, so the previews on the Company, Salary Slip, Company Documents and ID Card tabs show the real text.
// Sources are named on each function; keep them in step with that code.

import { footerContactLine } from "./pdf-text";

const clean = (value: string | null | undefined): string => (value ?? "").trim();

export type CompanyValues = {
  companyName: string;
  companyAddress: string;
  companyPhone: string;
  companyEmail: string;
  companyWebsite: string;
  companyGstin: string;
  companyTagline: string;
};

export type SlipValues = {
  slipCompanyName: string;
  slipCompanyAddress: string;
};

/** Letterhead and watermark of every letter (document_pdf.py company_header / PremiumPageDecorator). */
export const letterheadName = (companyName: string): string => (clean(companyName) || "UK TEXTILES").toUpperCase();

/** The company as letters name it in sentences ("employment with UK Textiles", company_documents_views.py). */
export const letterSentenceName = (companyName: string): string => clean(companyName) || "UK Textiles";

/** HR and MD sidebars, attendance printouts (HrLayout.tsx, dashboard-sidebar.tsx). */
export const sidebarName = (companyName: string): string => clean(companyName) || "UKTextiles";

/** {{company_name}} in every email the portal sends (email_service.company_name). */
export const emailCompanyName = (companyName: string, slipCompanyName: string): string =>
  clean(companyName) || clean(slipCompanyName) || "UKTextiles";

/** Company block of an ID card (growth_views.py _idcard_dict): the Company tab, else the Salary Slip tab. */
export const idCardCompany = (c: Pick<CompanyValues, "companyName" | "companyAddress">, s: SlipValues) => ({
  name: clean(c.companyName) || clean(s.slipCompanyName),
  address: clean(c.companyAddress) || clean(s.slipCompanyAddress),
});

/** Salary slip header (company_documents_views.py build_salary_slip_pdf): the Salary Slip tab name, else the Company
 *  name, in capitals; the line under it is the Salary Slip address only (no fallback; blank = no line). */
export const slipHeader = (s: SlipValues, companyName: string) => ({
  name: (clean(s.slipCompanyName) || clean(companyName) || "UK TEXTILES").toUpperCase(),
  address: clean(s.slipCompanyAddress),
});

/** The public QR verification page (growth_views.py verify_employee) names the Salary Slip tab's company. */
export const verifyPageCompany = (s: SlipValues) => ({
  name: clean(s.slipCompanyName),
  address: clean(s.slipCompanyAddress),
});

/** The line of contact details at the foot of every letter and salary slip page (PremiumPageDecorator). */
export const documentContactLine = (c: CompanyValues): string =>
  footerContactLine([c.companyAddress, c.companyPhone, c.companyEmail, c.companyWebsite]);

/** The right-hand column of a letter's letterhead (company_header): website, email, phone, one per line. */
export const letterheadContactLines = (c: CompanyValues): string[] =>
  [c.companyWebsite, c.companyEmail, c.companyPhone].map(clean).filter(Boolean);

export type DocType = "offer_letter" | "experience_letter" | "salary_slip" | "resignation_letter";

/** The small print at the very bottom of each page (the footer_note each builder passes). */
export function footerNote(doc: DocType, companyName: string, slipNumber = "SLP-2026-07-0001"): string {
  const name = letterSentenceName(companyName);
  switch (doc) {
    case "offer_letter":
      return `This is a system-generated offer letter from the ${name} HR Portal.`;
    case "experience_letter":
      return `This is a system-generated certificate from the ${name} HR Portal.`;
    case "resignation_letter":
      return `This is a system-generated letter from the ${name} HR Portal.`;
    case "salary_slip":
      return `System-generated payslip -${slipNumber}`;
  }
}

/** Heading printed under the letterhead of each document. */
export const DOCUMENT_TITLES: Record<DocType, string> = {
  offer_letter: "OFFER LETTER",
  experience_letter: "WORK EXPERIENCE CERTIFICATE",
  salary_slip: "SALARY SLIP",
  resignation_letter: "RESIGNATION ACCEPTANCE LETTER",
};

/** Report Center and attendance export letterheads (reporting/branding.py + export_xlsx / export_pdf). */
export function reportLetterhead(c: CompanyValues) {
  const contact = [c.companyPhone, c.companyEmail, c.companyWebsite].map(clean).filter(Boolean).join("  |  ");
  const gstin = clean(c.companyGstin);
  const sub = [clean(c.companyAddress), contact, gstin ? `GSTIN ${gstin}` : ""].filter(Boolean).join("  |  ");
  return {
    name: clean(c.companyName) || "UKTextiles",
    /** Second line of PDF exports (empty when nothing is filled in). */
    pdfSubLine: sub,
    /** Second line of Excel exports: the same, or the tagline when everything above is blank. */
    excelSubLine: sub || clean(c.companyTagline),
  };
}
