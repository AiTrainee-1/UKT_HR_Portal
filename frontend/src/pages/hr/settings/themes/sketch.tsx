import type { ThemeId } from "@/lib/themes";
import { hex, PALETTES, type PaletteToken } from "./palettes";

// A small drawing of one page of the portal in a theme: the left menu, a page heading, a card with a highlighted row
// and the two kinds of button. Every colour is the theme's own token from palettes.ts (which themes.test.ts keeps in
// step with src/index.css), with any custom colours laid on top, so the picture is the real palette, not a hand-typed
// strip of swatches.

export type Palette = Record<PaletteToken, string>;

/** The theme's palette with the custom colours (HSL triples by token) laid over it. */
export function paletteOf(theme: ThemeId, custom: Record<string, string> = {}): Palette {
  const out: Palette = { ...PALETTES[theme] };
  for (const [token, value] of Object.entries(custom)) {
    if (token in out) out[token as PaletteToken] = value;
  }
  return out;
}

const css = (triple: string) => `hsl(${triple})`;

export function PortalSketch({
  theme,
  custom,
  label,
}: {
  theme: ThemeId;
  custom?: Record<string, string>;
  label: string;
}) {
  const p = paletteOf(theme, custom);
  const menu = [26, 38, 50, 62, 74];
  const rows = [52, 60];
  return (
    <svg
      role="img"
      aria-label={`${label}: a page of the portal in this theme`}
      viewBox="0 0 220 128"
      width="100%"
      className="block rounded-xl ring-1 ring-black/10"
      data-testid="theme-sketch"
      data-theme-id={theme}
    >
      <rect width={220} height={128} rx={8} fill={css(p["--background"])} data-sketch="background" />
      {/* the left menu */}
      <path
        d="M8,0 H62 V128 H8 A8,8 0 0 1 0,120 V8 A8,8 0 0 1 8,0 Z"
        fill={css(p["--sidebar"])}
        data-sketch="sidebar"
      />
      <circle cx={16} cy={13} r={5} fill={css(p["--primary"])} />
      <rect x={25} y={10.5} width={26} height={5} rx={2.5} fill={css(p["--sidebar-foreground"])} />
      {menu.map((y, i) =>
        i === 1 ? (
          <g key={y}>
            <rect x={7} y={y - 4} width={48} height={12} rx={4} fill={css(p["--primary"])} data-sketch="menu-active" />
            <rect x={13} y={y} width={28} height={4} rx={2} fill={css(p["--primary-foreground"])} />
          </g>
        ) : (
          <rect
            key={y}
            x={13}
            y={y}
            width={30 + (i % 3) * 6}
            height={4}
            rx={2}
            fill={css(p["--sidebar-foreground"])}
            opacity={0.55}
          />
        ),
      )}
      {/* page heading and a line of quiet text */}
      <rect x={74} y={11} width={64} height={6} rx={3} fill={css(p["--foreground"])} data-sketch="heading" />
      <rect x={74} y={22} width={110} height={3.5} rx={1.75} fill={css(p["--muted-foreground"])} />
      {/* a card with a title, two rows and a selected row */}
      <rect
        x={74}
        y={33}
        width={136}
        height={58}
        rx={7}
        fill={css(p["--card"])}
        stroke={css(p["--border"])}
        strokeWidth={1}
        data-sketch="card"
      />
      <rect x={82} y={41} width={52} height={4.5} rx={2.25} fill={css(p["--card-foreground"])} />
      {rows.map((y) => (
        <rect
          key={y}
          x={82}
          y={y}
          width={100}
          height={3.5}
          rx={1.75}
          fill={css(p["--muted-foreground"])}
          opacity={0.8}
        />
      ))}
      <rect x={81} y={69} width={122} height={13} rx={4} fill={css(p["--accent"])} data-sketch="accent-row" />
      <rect x={87} y={73.5} width={44} height={4} rx={2} fill={css(p["--accent-foreground"])} />
      {/* a primary button and a quiet one */}
      <rect x={74} y={101} width={48} height={17} rx={6} fill={css(p["--primary"])} data-sketch="primary-button" />
      <text
        x={98}
        y={112.5}
        textAnchor="middle"
        fontFamily="'Hanken Grotesk', 'Inter', sans-serif"
        fontWeight={700}
        fontSize={8}
        fill={css(p["--primary-foreground"])}
      >
        Save
      </text>
      <rect x={128} y={101} width={48} height={17} rx={6} fill="none" stroke={css(p["--border"])} strokeWidth={1.2} />
      <rect x={140} y={107.5} width={24} height={4} rx={2} fill={css(p["--foreground"])} opacity={0.8} />
    </svg>
  );
}

/** The five colours worth naming, as a strip under the drawing: page, card, primary, accent and text. */
export const SWATCHES: { token: PaletteToken; name: string }[] = [
  { token: "--background", name: "Page" },
  { token: "--card", name: "Card" },
  { token: "--primary", name: "Primary" },
  { token: "--accent", name: "Accent" },
  { token: "--foreground", name: "Text" },
];

export function Swatches({ palette }: { palette: Palette }) {
  return (
    <ul className="flex gap-1.5" aria-label="Colours of this theme">
      {SWATCHES.map(({ token, name }) => (
        <li key={token} className="min-w-0 flex-1">
          <span
            className="block h-4 rounded-md ring-1 ring-black/10"
            style={{ background: css(palette[token]) }}
            title={`${name} ${hex(palette[token])}`}
            data-swatch={token}
            data-hex={hex(palette[token])}
          />
          <span className="mt-0.5 block truncate text-[9px] font-semibold uppercase tracking-wide text-gray-500">
            {name}
          </span>
        </li>
      ))}
    </ul>
  );
}
