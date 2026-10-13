import type { SettingMeta } from "./kit/catalog";

const tab = "idcard";
const COLOURS = "Colours";
const SHAPE = "Typeface and layout";
const BACK = "Back of the card";

/** Every setting on the ID Card tab, for the page's search (see kit/catalog.ts). */
export const ID_CARD_SETTINGS: SettingMeta[] = [
  {
    id: "idcard-primary",
    tab,
    section: COLOURS,
    title: "Primary Color",
    purpose:
      "The card's main colour: the top band, the code strip, the designation pill and the strips along the edges.",
    keywords: ["id card", "colour", "color", "primary", "brand", "band"],
  },
  {
    id: "idcard-secondary",
    tab,
    section: COLOURS,
    title: "Secondary Color",
    purpose: "The card's second colour: where the top band's gradient ends, and the frame around the photo.",
    keywords: ["id card", "colour", "color", "secondary", "gradient", "photo frame"],
  },
  {
    id: "idcard-text",
    tab,
    section: COLOURS,
    title: "Text Color",
    purpose: "The colour of the employee's name and of the detail values on the front of the card.",
    keywords: ["id card", "colour", "color", "text", "name"],
  },
  {
    id: "idcard-font",
    tab,
    section: SHAPE,
    title: "Font Family",
    purpose: "The typeface the card is printed in.",
    keywords: ["id card", "font", "typeface", "poppins", "roboto", "inter"],
  },
  {
    id: "idcard-background",
    tab,
    section: SHAPE,
    title: "Background Style",
    purpose:
      "How the coloured band at the top of the card is filled: a gradient, one solid colour, or a gradient with a fine dot pattern.",
    keywords: ["id card", "background", "gradient", "solid", "pattern", "header"],
  },
  {
    id: "idcard-logo-position",
    tab,
    section: SHAPE,
    title: "Logo Position",
    purpose: "Whether the logo sits to the left of the company name or centred above it.",
    keywords: ["id card", "logo", "position", "centre", "center", "left"],
  },
  {
    id: "idcard-corners",
    tab,
    section: SHAPE,
    title: "Corner Style",
    purpose: "Rounded or square corners for the card and its photo.",
    keywords: ["id card", "corner", "rounded", "sharp", "shape"],
  },
  {
    id: "idcard-footer",
    tab,
    section: BACK,
    title: "Footer Text (optional)",
    purpose: "One extra line in italics at the end of the instructions on the back of the card.",
    keywords: ["id card", "footer", "validity", "back", "text"],
  },
  {
    id: "idcard-qr",
    tab,
    section: BACK,
    title: "Show QR verification code on back",
    purpose: "Whether the back of the card carries a QR code that opens the public employee-verification page.",
    keywords: ["id card", "qr", "verify", "verification", "scan", "back"],
  },
];
