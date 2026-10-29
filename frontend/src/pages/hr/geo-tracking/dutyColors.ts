// On-Duty Map: one colour per employee, so several journeys on one map can be told apart (the route line, the numbered stop pins,
// the start / end pins and the legend row of an employee all use it). These are map overlays (Leaflet draws them as hex), which is
// why they are written here, next to the other map colours, and not as Tailwind classes.
//
// The colours avoid the meanings the portal already gives: red = simulated location, grey = no signal. An employee keeps the same
// colour while the page is open (assignDutyColors keeps what it gave before and only adds the new ones), so a refresh never
// repaints somebody's route.

export const DUTY_PALETTE: readonly string[] = [
  "#2563eb", // blue
  "#d97706", // amber
  "#c026d3", // magenta
  "#047857", // emerald
  "#65a30d", // lime
  "#78350f", // brown
  "#1e3a8a", // navy
  "#86198f", // plum
  "#0891b2", // cyan
  "#7c3aed", // violet
  "#a16207", // ochre
  "#4d7c0f", // olive
];

function hslToHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number): string => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * c)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

/** The colour of the n-th employee (0-based): the palette first, then evenly spread hues, still dark enough to read on a map. */
export function dutyColor(index: number): string {
  if (index < DUTY_PALETTE.length) return DUTY_PALETTE[Math.max(0, index)];
  const hue = (index * 137.508) % 360; // the golden angle: neighbours are never alike
  return hslToHex(hue, 0.62, 0.4);
}

/**
 * Colour slots for employees. An employee that already has a slot keeps it; a new one gets the lowest slot nobody uses (the new
 * ones in order of employee id, so the same people get the same colours on every visit). Employees that are no longer listed
 * free their slot.
 */
export function assignDutyColors(
  ids: readonly number[],
  previous: ReadonlyMap<number, number> = new Map(),
): Map<number, number> {
  const wanted = new Set(ids);
  const result = new Map<number, number>();
  const used = new Set<number>();
  for (const [id, slot] of previous) {
    if (wanted.has(id) && !used.has(slot)) {
      result.set(id, slot);
      used.add(slot);
    }
  }
  for (const id of [...wanted].sort((a, b) => a - b)) {
    if (result.has(id)) continue;
    let slot = 0;
    while (used.has(slot)) slot += 1;
    result.set(id, slot);
    used.add(slot);
  }
  return result;
}

/** Two colours that are close enough to be mistaken for one another (a test of the palette itself). */
export function colorDistance(a: string, b: string): number {
  const rgb = (hex: string): [number, number, number] => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
  const [r1, g1, b1] = rgb(a);
  const [r2, g2, b2] = rgb(b);
  // the "redmean" approximation of how different two colours look
  const rMean = (r1 + r2) / 2;
  return Math.sqrt(
    (2 + rMean / 256) * (r1 - r2) ** 2 + 4 * (g1 - g2) ** 2 + (2 + (255 - rMean) / 256) * (b1 - b2) ** 2,
  );
}
