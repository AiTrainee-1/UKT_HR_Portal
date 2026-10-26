import type { ThemeId } from "@/lib/themes";
import { hex, PALETTES, type PaletteToken } from "./palettes";

// A small drawing of one page of the portal in a theme: the left menu, a page heading, a card with a highlighted row
// and the two kinds of button. Every colour is the theme's own token from palettes.ts (which themes.test.ts keeps in
// step with src/index.css and src/themes/clean/tokens.css), with any custom colours laid on top, so the picture is the
// real palette, not a hand-typed strip of swatches. Clean Professional is drawn by its own function (CleanSketch): it is
// flat and square-cornered, with a white menu, a table and an underline tab, which is how it really looks.

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

/** Clean Professional: flat surfaces, 1px borders, 4px corners, a white menu with a bar on the open page, a table. */
function CleanSketch({ theme, custom, label }: { theme: ThemeId; custom?: Record<string, string>; label: string }) {
  const p = paletteOf(theme, custom);
  const menu = [26, 50, 62, 74];
  const rows = [66, 82];
  return (
    <svg
      role="img"
      aria-label={`${label}: a page of the portal in this theme`}
      viewBox="0 0 220 128"
      width="100%"
      className="block rounded-md ring-1 ring-black/10"
      data-testid="theme-sketch"
      data-theme-id={theme}
    >
      <rect width={220} height={128} rx={4} fill={css(p["--background"])} data-sketch="background" />
      {/* the left menu: white, a thin line on its right edge, the open page marked by a soft fill and a bar */}
      <path
        d="M4,0 H62 V128 H4 A4,4 0 0 1 0,124 V4 A4,4 0 0 1 4,0 Z"
        fill={css(p["--sidebar"])}
        data-sketch="sidebar"
      />
      <rect x={61.5} y={0} width={1} height={128} fill={css(p["--border"])} />
      <rect x={8} y={9} width={9} height={9} rx={2} fill={css(p["--primary"])} />
      <rect x={21} y={11.5} width={30} height={4} rx={2} fill={css(p["--sidebar-foreground"])} />
      <rect x={0} y={21} width={61} height={1} fill={css(p["--border"])} />
      {menu.map((y, i) =>
        i === 1 ? (
          <g key={y}>
            <rect x={4} y={y - 4} width={54} height={12} rx={3} fill={css(p["--accent"])} data-sketch="menu-active" />
            <rect x={4} y={y - 4} width={2.5} height={12} rx={1} fill={css(p["--primary"])} />
            <rect x={12} y={y} width={30} height={4} rx={2} fill={css(p["--accent-foreground"])} />
          </g>
        ) : (
          <rect
            key={y}
            x={12}
            y={y}
            width={28 + (i % 3) * 6}
            height={4}
            rx={2}
            fill={css(p["--sidebar-foreground"])}
            opacity={0.55}
          />
        ),
      )}
      {/* page heading, a line of quiet text and a tab row with the open tab underlined */}
      <rect x={72} y={9} width={60} height={6} rx={2} fill={css(p["--foreground"])} data-sketch="heading" />
      <rect x={72} y={19} width={104} height={3.5} rx={1.75} fill={css(p["--muted-foreground"])} />
      <rect x={72} y={32} width={140} height={1} fill={css(p["--border"])} />
      <rect x={72} y={27} width={26} height={4} rx={2} fill={css(p["--primary"])} />
      <rect x={72} y={31} width={26} height={2} fill={css(p["--primary"])} />
      <rect x={104} y={27} width={26} height={4} rx={2} fill={css(p["--muted-foreground"])} opacity={0.6} />
      {/* a table in a bordered card: grey header, thin row lines, one selected row */}
      <rect
        x={72.5}
        y={38.5}
        width={139}
        height={58}
        rx={4}
        fill={css(p["--card"])}
        stroke={css(p["--border"])}
        strokeWidth={1}
        data-sketch="card"
      />
      <rect x={73} y={39} width={138} height={11} rx={3.5} fill={css(p["--background"])} />
      <rect x={73} y={49} width={138} height={1} fill={css(p["--border"])} />
      <rect x={79} y={43} width={30} height={3.5} rx={1.75} fill={css(p["--muted-foreground"])} />
      <rect x={128} y={43} width={20} height={3.5} rx={1.75} fill={css(p["--muted-foreground"])} />
      <rect x={176} y={43} width={24} height={3.5} rx={1.75} fill={css(p["--muted-foreground"])} />
      <rect x={73} y={51} width={138} height={12} fill={css(p["--accent"])} data-sketch="accent-row" />
      <rect x={79} y={55} width={34} height={4} rx={2} fill={css(p["--accent-foreground"])} />
      <rect x={128} y={55} width={22} height={4} rx={2} fill={css(p["--accent-foreground"])} opacity={0.7} />
      {rows.map((y) => (
        <g key={y}>
          <rect x={73} y={y - 3} width={138} height={1} fill={css(p["--border"])} />
          <rect x={79} y={y + 1} width={38} height={3.5} rx={1.75} fill={css(p["--card-foreground"])} opacity={0.8} />
          <rect x={128} y={y + 1} width={24} height={3.5} rx={1.75} fill={css(p["--muted-foreground"])} opacity={0.8} />
          <rect x={176} y={y + 1} width={18} height={3.5} rx={1.75} fill={css(p["--muted-foreground"])} opacity={0.8} />
        </g>
      ))}
      {/* a solid primary button and a plain bordered one */}
      <rect x={72} y={104} width={46} height={16} rx={4} fill={css(p["--primary"])} data-sketch="primary-button" />
      <text
        x={95}
        y={115}
        textAnchor="middle"
        fontFamily="'Hanken Grotesk', 'Inter', sans-serif"
        fontWeight={600}
        fontSize={8}
        fill={css(p["--primary-foreground"])}
      >
        Save
      </text>
      <rect
        x={124.5}
        y={104.5}
        width={45}
        height={15}
        rx={4}
        fill={css(p["--card"])}
        stroke={css(p["--border"])}
        strokeWidth={1}
      />
      <rect x={136} y={110} width={22} height={4} rx={2} fill={css(p["--foreground"])} opacity={0.8} />
    </svg>
  );
}

export function PortalSketch({
  theme,
  custom,
  label,
}: {
  theme: ThemeId;
  custom?: Record<string, string>;
  label: string;
}) {
  if (theme === "clean") return <CleanSketch theme={theme} custom={custom} label={label} />;
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
