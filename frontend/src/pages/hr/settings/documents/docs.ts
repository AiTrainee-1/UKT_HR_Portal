import type { DocumentType } from "@/lib/api-client/custom-hooks";
import type { Affect } from "../kit/SettingBlock";

/** The four documents the Company Documents tab styles, and where each is made. */
export type DocDef = {
  type: DocumentType;
  title: string;
  /** Where HR (or the employee) gets this document. */
  made: string;
  usedBy: { label: string; to?: string }[];
};

export const DOCS: DocDef[] = [
  {
    type: "offer_letter",
    title: "Offer Letter",
    made: "Generated from an employee's profile (Generate Offer Letter), from Recruitment > New Joinees and from Recruitment Documents, and attached to the offer email and WhatsApp message.",
    usedBy: [
      { label: "Employees", to: "/hr/employees" },
      { label: "New Joinees", to: "/hr/recruitment/new-joinees" },
      { label: "Recruitment Documents", to: "/hr/recruitment/documents" },
    ],
  },
  {
    type: "experience_letter",
    title: "Experience Letter",
    made: "Generated from an employee's profile and from Recruitment Documents, and sent on WhatsApp.",
    usedBy: [
      { label: "Employees", to: "/hr/employees" },
      { label: "Recruitment Documents", to: "/hr/recruitment/documents" },
    ],
  },
  {
    type: "salary_slip",
    title: "Salary Slip",
    made: "The slip PDF from Staff and Production Payroll, the slips employees download in the apps, and the PDF attached to slip emails and WhatsApp. The 2-slips-per-page print uses only the two colours.",
    usedBy: [
      { label: "Staff Payroll", to: "/hr/payroll" },
      { label: "Production Payroll", to: "/hr/production-payroll" },
      { label: "Employee apps" },
    ],
  },
  {
    type: "resignation_letter",
    title: "Resignation Letter",
    made: "Generated from Recruitment > Resignations once a resignation is approved and from Recruitment Documents, and sent by email and WhatsApp.",
    usedBy: [
      { label: "Resignations", to: "/hr/recruitment/resignations" },
      { label: "Recruitment Documents", to: "/hr/recruitment/documents" },
    ],
  },
];

const isSlip = (t: DocumentType) => t === "salary_slip";

/** What each of the six settings changes on this document (document_pdf.py, company_documents_views.py). */
export function affectsOf(
  t: DocumentType,
): Record<"primary" | "accent" | "heading" | "tagline" | "logo" | "watermark", Affect[]> {
  if (isSlip(t))
    return {
      primary: [
        {
          where: "Salary slip PDF",
          what: "the company name and title, the month badge, the field labels, the Earnings table header, the NET AMOUNT PAID band, the footer band and the watermark",
        },
        { where: "2-slips-per-page print", what: "the company name, the Earnings header and the NET AMOUNT PAID band" },
      ],
      accent: [
        {
          where: "Salary slip PDF",
          what: "the page border, the rule under the header, the footer's curve, the Deductions table header and the outlines of the badge and NET AMOUNT PAID band",
        },
        {
          where: "2-slips-per-page print",
          what: 'the "SALARY SLIP - month" title, the rule and the Deductions header',
        },
      ],
      heading: [
        { where: "Salary slip PDF", what: "the company name and the SALARY SLIP title (body text is always Arial)" },
        { where: "2-slips-per-page print", what: "not used (always sans)" },
      ],
      tagline: [
        { where: "Salary slip PDF", what: "an italic line in the coloured footer of every page; blank leaves it out" },
        { where: "2-slips-per-page print", what: "not printed (that print has no footer)" },
      ],
      logo: [
        { where: "Salary slip PDF", what: "top-left of the slip header, in place of the Company tab's logo" },
        { where: "2-slips-per-page print", what: "not printed (that print has no logo)" },
      ],
      watermark: [
        {
          where: "Salary slip PDF",
          what: "every page; the Company tab's name in capitals, turned 35 degrees, very pale",
        },
        { where: "2-slips-per-page print", what: "never has a watermark" },
      ],
    };
  const letter = "Every page of the letter";
  return {
    primary: [
      {
        where: letter,
        what:
          t === "resignation_letter"
            ? "the company name, the title, the signatory's name, the coloured footer band, the watermark and the label column of the details table"
            : "the company name, the title, the signatory's name, the coloured footer band and the watermark",
      },
    ],
    accent: [
      {
        where: letter,
        what:
          t === "resignation_letter"
            ? "the double page border and its corner ticks, the rule under the letterhead, the line under the title, the footer's curve and the details table's border"
            : "the double page border and its corner ticks, the rule under the letterhead, the line under the title and the footer's curve",
      },
    ],
    heading: [
      {
        where: letter,
        what: "the company name in the letterhead, the title and the signatory's name (body text is always Arial; the watermark and footer slogan are always serif)",
      },
    ],
    tagline: [{ where: letter, what: "an italic line in the coloured footer; blank leaves it out" }],
    logo: [{ where: letter, what: "top-left of the letterhead, in place of the Company tab's logo" }],
    watermark: [{ where: letter, what: "the Company tab's name in capitals, turned 35 degrees, very pale" }],
  };
}
