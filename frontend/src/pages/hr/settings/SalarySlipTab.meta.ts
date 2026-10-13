import type { SettingMeta } from "./kit/catalog";

const tab = "salary-slip";
const SLIP = "Salary Slip Settings";
const SIGNATURES = "Signatures";

/** Every setting on the Salary Slip tab, for the page's search (see kit/catalog.ts). */
export const SALARY_SLIP_SETTINGS: SettingMeta[] = [
  {
    id: "slip-company-name",
    tab,
    section: SLIP,
    title: "Company Name (on slip header)",
    purpose:
      "The company name printed in capitals at the top of every salary slip. It can carry the branch, such as UK TEXTILES - H.O.",
    keywords: ["slip", "header", "company", "name", "branch", "payslip"],
  },
  {
    id: "slip-company-address",
    tab,
    section: SLIP,
    title: "Company Address / City",
    purpose: "The line printed under that name at the top of the salary slip.",
    keywords: ["slip", "header", "address", "city", "payslip"],
  },
  {
    id: "min-wage-rate",
    tab,
    section: SLIP,
    title: "Minimum Rate of Wages",
    purpose:
      "The statutory minimum wage printed on every salary slip, and the figure the Minimum Wage Compliance report checks pay against. It never changes pay, PF or ESI.",
    keywords: ["minimum wage", "wages", "compliance", "statutory", "rate"],
  },
  {
    id: "slip-signature",
    tab,
    section: SIGNATURES,
    title: "Employer signature on salary slips",
    purpose:
      'The signature printed above "Employer Signature" on the salary slip PDF. ID cards use it only when the authorised signature is empty.',
    keywords: ["signature", "employer", "proprietor", "slip", "sign"],
  },
  {
    id: "authorised-signature",
    tab,
    section: SIGNATURES,
    title: "Authorised signature on letters and ID cards",
    purpose:
      'The signature printed above "Authorized Signatory" on offer letters, experience certificates and resignation acceptance letters, and on the back of ID cards.',
    keywords: ["signature", "authorised", "authorized", "letter", "resignation", "offer", "experience", "id card"],
  },
];
