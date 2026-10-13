import type { SettingMeta } from "./kit/catalog";

const tab = "documents";
const LOOK = "Each document's look";

/** Every setting on the Company Documents tab, for the page's search (see kit/catalog.ts). Each of the four documents
 *  (offer letter, experience letter, salary slip, resignation letter) has its own copy of these six. */
export const DOCUMENTS_SETTINGS: SettingMeta[] = [
  {
    id: "doc-primary",
    tab,
    section: LOOK,
    title: "Theme Color (Primary)",
    purpose: "The main colour of the document: its headings, the coloured footer band and the faint watermark.",
    keywords: ["colour", "color", "theme", "primary", "letter", "slip", "brand"],
  },
  {
    id: "doc-accent",
    tab,
    section: LOOK,
    title: "Accent Color",
    purpose: "The trim colour of the document: the page border, the rules under the headings and the footer's curve.",
    keywords: ["colour", "color", "accent", "border", "gold", "letter", "slip"],
  },
  {
    id: "doc-heading",
    tab,
    section: LOOK,
    title: "Heading Style",
    purpose: "The typeface of the company name, the document's title and the signatory's name: serif or sans.",
    keywords: ["font", "typeface", "heading", "serif", "sans", "title"],
  },
  {
    id: "doc-tagline",
    tab,
    section: LOOK,
    title: "Footer Tagline",
    purpose: "The slogan printed in italics in the coloured footer of every page.",
    keywords: ["tagline", "slogan", "footer", "motto"],
  },
  {
    id: "doc-logo",
    tab,
    section: LOOK,
    title: "Logo Override (optional)",
    purpose:
      "A different logo for this document only, in place of the Company tab's logo (for example a co-branded offer letter).",
    keywords: ["logo", "override", "image", "letterhead"],
  },
  {
    id: "doc-watermark",
    tab,
    section: LOOK,
    title: "Show faint watermark",
    purpose: "A pale diagonal company name behind the text of every page.",
    keywords: ["watermark", "background", "faint"],
  },
];
