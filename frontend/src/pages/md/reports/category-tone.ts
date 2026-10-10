// The colour of each report category on the MD's Reports page: the tile behind its icon and the dot beside its name.
// Wine stays the accent of the page, so the categories take the quieter members of the palette (periwinkle, mauve, rose,
// terracotta, indigo ...). Sage, ochre and crimson are left out on purpose: they mean good / watch / bad everywhere else.
// The classes are written out in full because Tailwind cannot build a class name from a variable; the `md-money-t-*` ones
// are in md-theme/areas/money.css.

export type CategoryTone = {
  /** `md-money-t-*`: sets the tone an `md-money-tile` is painted with. */
  tone: string;
  /** A small filled dot in the same colour. */
  dot: string;
};

const TONES: Record<string, CategoryTone> = {
  md: { tone: "md-money-t-wine", dot: "bg-md-wine-600" },
  finance: { tone: "md-money-t-wine", dot: "bg-md-wine-500" },
  payroll: { tone: "md-money-t-clay", dot: "bg-md-clay-500" },
  attendance: { tone: "md-money-t-info", dot: "bg-md-info-500" },
  leave: { tone: "md-money-t-mauve", dot: "bg-md-mauve-500" },
  gate: { tone: "md-money-t-sky", dot: "bg-md-sky-500" },
  employees: { tone: "md-money-t-ink", dot: "bg-md-ink-600" },
  hr: { tone: "md-money-t-rose", dot: "bg-md-rose-500" },
  admin: { tone: "md-money-t-neutral", dot: "bg-md-n-500" },
};

/** The tone of a category (the quiet neutral for one the page does not know). */
export function categoryTone(id: string): CategoryTone {
  return TONES[id] ?? TONES.admin;
}
