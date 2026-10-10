import { useLayoutEffect, useRef } from "react";
import { Mascot } from "page-mascot";
import { cn } from "@/lib/utils";

// The AI assistant's character: the radio (public/mascots/radio-directions.webp and radio-reactions.webp, the two sheets
// that the `page-mascot` package draws from). Two ways it appears:
//
//   RadioMascot  the package's own component: the head follows the pointer and a poke makes it blink, show a heart or
//                sparkles, or go dizzy if poked repeatedly. The floating launcher and the panel's welcome use it.
//   MascotFace   the same sheets, as a still face for the small avatars (the panel's header and each reply), whose
//                expression follows what the assistant is doing. Many of these can be on screen at once, so they carry
//                no pointer tracking.
//
// Both sheets are 3x3 grids with the character in the same place in every cell; the order of the cells is the
// package's (node_modules/page-mascot/dist/mascot.js: DIRECTIONS and REACTIONS), repeated below because the package does
// not export it.

const base = import.meta.env.BASE_URL;
export const RADIO_SHEETS = {
  directions: `${base}mascots/radio-directions.webp`,
  reactions: `${base}mascots/radio-reactions.webp`,
} as const;

/** The package's reaction cells, in sheet order. */
const REACTIONS = [
  "blink",
  "heart",
  "sparkle",
  "surprised",
  "wink",
  "bashful",
  "sleepy",
  "dizzy",
  "delighted",
] as const;
/** The cell of the directions sheet where the head looks straight ahead. */
const LOOKING_STRAIGHT = 4;

/** What the assistant is doing, as the face shows it. */
export type MascotMood = "idle" | "working" | "pleased" | "error" | "stopped";

const MOOD_REACTION: Record<Exclude<MascotMood, "idle">, (typeof REACTIONS)[number]> = {
  working: "sparkle",
  pleased: "delighted",
  error: "dizzy",
  stopped: "sleepy",
};

/** The package's interactive character. `buttonLabel` renames the button for a screen reader (the package calls every one
 *  "Boop the <label>", which is right for a toy and wrong for the button that opens the assistant). */
export function RadioMascot({
  size,
  label = "AI assistant",
  buttonLabel,
  className,
}: {
  size: number;
  label?: string;
  buttonLabel?: string;
  className?: string;
}) {
  const holder = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    // the package renders `aria-label` from a constant, so React never writes it again: setting it once here is enough
    if (buttonLabel) holder.current?.querySelector("button")?.setAttribute("aria-label", buttonLabel);
  }, [buttonLabel]);
  return (
    <span ref={holder} style={{ display: "contents" }}>
      <Mascot {...RADIO_SHEETS} size={size} label={label} className={className} />
    </span>
  );
}

/** How far the face is zoomed into its cell (1 = the whole cell: head and shoulders), and where in the cell the head's
 *  centre is (the antenna is above it). Tuned for the radio sheets. */
const ZOOM = 1.45;
const HEAD_CENTRE_Y = 0.4;

/** The still avatar: the radio's face in a round frame, its expression following `mood`. */
export function MascotFace({
  size = 36,
  mood = "idle",
  className,
}: {
  size?: number;
  mood?: MascotMood;
  className?: string;
}) {
  const cellIndex = mood === "idle" ? LOOKING_STRAIGHT : REACTIONS.indexOf(MOOD_REACTION[mood]);
  const col = cellIndex % 3;
  const row = Math.floor(cellIndex / 3);
  const sheet = mood === "idle" ? RADIO_SHEETS.directions : RADIO_SHEETS.reactions;
  // the cell's head goes to the middle of the frame, whatever the cell
  const x = size / 2 - (col + 0.5) * ZOOM * size;
  const y = size / 2 - (row + HEAD_CENTRE_Y) * ZOOM * size;
  return (
    <span
      aria-hidden
      data-testid="assistant-face"
      data-mood={mood}
      className={cn("block shrink-0 overflow-hidden rounded-full bg-[#fff1cc] shadow-sm ring-2 ring-white", className)}
      style={{
        width: size,
        height: size,
        backgroundImage: `url(${sheet})`,
        backgroundRepeat: "no-repeat",
        backgroundSize: `${3 * ZOOM * size}px ${3 * ZOOM * size}px`,
        backgroundPosition: `${x}px ${y}px`,
      }}
    />
  );
}
