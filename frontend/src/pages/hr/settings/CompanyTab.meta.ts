import type { SettingMeta } from "./kit/catalog";

const tab = "company";
const PROFILE = "Company Profile";
const CONTACT = "Address and contact details";
const REPORTS = "Only on exported reports";

/** Every setting on the Company tab, for the page's search (see kit/catalog.ts). */
export const COMPANY_SETTINGS: SettingMeta[] = [
  {
    id: "company-logo",
    tab,
    section: PROFILE,
    title: "Company Logo",
    purpose:
      "The company's logo. It sits beside the company name at the top of the portal's sidebar and is printed on letters, salary slips, ID cards and report headers.",
    keywords: ["logo", "image", "brand", "letterhead", "picture"],
  },
  {
    id: "company-name",
    tab,
    section: PROFILE,
    title: "Company Name",
    purpose:
      "The company's name as the portal shows and prints it: the sidebar title, the letterhead and sentences of letters, the watermark, emails, ID cards and report headers.",
    keywords: ["name", "brand", "letterhead", "watermark", "email subject", "sidebar"],
  },
  {
    id: "company-address",
    tab,
    section: CONTACT,
    title: "Address",
    purpose:
      "The company's postal address, printed under the name on letters, in the footer of every letter and salary slip page, on ID cards and on report headers.",
    keywords: ["address", "location", "footer", "letterhead", "id card"],
  },
  {
    id: "company-phone",
    tab,
    section: CONTACT,
    title: "Phone",
    purpose: "The company's main phone number for documents: the letterhead, the page footer and report headers.",
    keywords: ["phone", "telephone", "contact", "footer", "letterhead"],
  },
  {
    id: "company-email",
    tab,
    section: CONTACT,
    title: "Email",
    purpose: "The company's contact email for documents: the letterhead, the page footer and report headers.",
    keywords: ["email", "mail", "contact", "footer", "letterhead"],
  },
  {
    id: "company-website",
    tab,
    section: CONTACT,
    title: "Website",
    purpose: "The company's website for documents: the letterhead, the page footer and report headers.",
    keywords: ["website", "web", "url", "footer", "letterhead"],
  },
  {
    id: "company-gstin",
    tab,
    section: REPORTS,
    title: "GSTIN",
    purpose: "The company's GST registration number. It is printed only on the header of exported reports.",
    keywords: ["gst", "gstin", "tax", "registration", "report"],
  },
  {
    id: "company-tagline",
    tab,
    section: REPORTS,
    title: "Tagline",
    purpose:
      "A one-line slogan. Only Excel exports print it, and only when the address, phone, email, website and GSTIN are all blank.",
    keywords: ["tagline", "slogan", "motto", "excel"],
  },
];
