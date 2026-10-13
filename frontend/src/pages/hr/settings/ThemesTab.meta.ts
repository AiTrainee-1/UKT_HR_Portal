import type { SettingMeta } from "./kit/catalog";

const tab = "themes";
const THEMES = "Themes";

/** Every setting on the Themes tab, for the page's search (see kit/catalog.ts). */
export const THEMES_SETTINGS: SettingMeta[] = [
  {
    id: "theme-active",
    tab,
    section: THEMES,
    title: "Active theme",
    purpose:
      "The colour scheme every user of the portal sees. Switching one on saves it at once for everyone; there is no separate Save.",
    keywords: [
      "theme",
      "look",
      "appearance",
      "colour scheme",
      "color scheme",
      "dark",
      "light",
      "premium",
      "gold",
      "black and white",
      "mono",
      "professional",
      "preview",
      "portal",
    ],
  },
  {
    id: "theme-custom",
    tab,
    section: THEMES,
    title: "Custom colours",
    purpose:
      "Six colours of the active theme replaced with your own: primary, background, card, text, sidebar and accent. The theme's other colours stay as they are.",
    keywords: [
      "custom",
      "customize",
      "customise",
      "colour",
      "color",
      "brand",
      "primary",
      "background",
      "card",
      "text",
      "sidebar",
      "accent",
      "reset",
    ],
  },
];
