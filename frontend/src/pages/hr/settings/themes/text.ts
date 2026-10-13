import type { ThemeId } from "@/lib/themes";

// The words of the Themes tab: what each theme looks like and what each editable colour really colours. The facts are
// read from the code that uses the tokens: body and the Card component (src/index.css, components/ui/card.tsx), the
// switch (ui/switch.tsx), the main button (ui/button.tsx: a fixed blue gradient, not --primary), the HR portal's left
// menu (ui/dashboard-sidebar.tsx: fixed white and blue, not --sidebar) and the pages that use bg-sidebar / bg-accent.

/** What each theme looks like, in words (the drawing beside it shows the real colours from palettes.ts). */
export const THEME_LOOK: Record<ThemeId, string> = {
  default: "Light blue-grey pages, white cards, UKT blue switches, links and highlights.",
  dark: "Navy pages and cards, near-white text and switches, orange highlights.",
  premium: "Warm charcoal pages and cards, gold switches, links and highlights.",
  mono: "White pages, near-black switches and links, no colour at all.",
  "mono-dark": "Black pages, dark grey cards, white switches and links.",
  professional: "Very light slate pages, white cards, slate-blue switches and links.",
};

/** The six colours the Customize dialog edits (lib/themes.ts CUSTOMIZABLE_TOKENS), and what each really colours. */
export const TOKEN_TEXT: Record<string, { label: string; colours: string }> = {
  "--primary": {
    label: "Primary",
    colours:
      "Switches, tick boxes, badges, progress bars and links drawn in the theme's main colour. The portal's main action buttons keep their own fixed blue.",
  },
  "--background": {
    label: "Background",
    colours: "The page behind every card, on every page of the portal, and the knob of switches.",
  },
  "--card": {
    label: "Card surface",
    colours:
      "Cards and panels across the portal, including the employee pages and the employee sign-in and set-password screens. On this Settings page the frosted panels are translucent over it.",
  },
  "--foreground": {
    label: "Text",
    colours: "The default text colour of every page: text, inputs and notices that do not set a colour of their own.",
  },
  "--sidebar": {
    label: "Sidebar",
    colours:
      "The menu of the employee pages inside the portal, and the background of the employee sign-in, set-password and job application pages. The HR portal's own left menu keeps its fixed white and blue.",
  },
  "--accent": {
    label: "Accent",
    colours: "Hovered and selected items in drop-down lists, menus and pickers.",
  },
};
