import { cn } from "@/lib/utils";

const BARS = 28;

/** A row of wine bars that dance with the voice. `level` is 0..1 (the live loudness); each bar has its own phase so it looks
 *  like a voice and not a block. With no level it rests as a calm line. */
export default function Waveform({ level, active, className }: { level: number; active: boolean; className?: string }) {
  return (
    <div
      className={cn("flex h-9 items-center justify-center gap-[3px]", className)}
      aria-hidden
      data-testid="assistant-waveform"
    >
      {Array.from({ length: BARS }, (_, i) => {
        const shape = 0.35 + 0.65 * Math.abs(Math.sin(i * 0.83 + level * 9)); // each bar peaks at a different moment
        const edge = 1 - (Math.abs(i - BARS / 2) / (BARS / 2)) * 0.55; // taller in the middle
        const height = active ? 4 + level * 30 * shape * edge : 4;
        return (
          <span
            key={i}
            className={cn(
              "w-[3px] rounded-full transition-[height] duration-100",
              active ? "bg-gradient-to-t from-md-wine-700 to-md-wine-300" : "bg-md-wine/25",
            )}
            style={{ height }}
          />
        );
      })}
    </div>
  );
}
