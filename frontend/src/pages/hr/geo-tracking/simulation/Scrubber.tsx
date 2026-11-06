// Journey Simulation: the progress bar, which is also the scrubber. The stops (amber, purple from 15 minutes) and the gaps (grey)
// are drawn on it so HR sees where they are before playing; drag or click anywhere to jump there; the keyboard works like any
// slider (arrows 1 %, Page Up / Down 10 %, Home / End).
import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "@/lib/utils";
import { fmtTime } from "../logic";
import { bands, progressOf, timeAtProgress, type SimTrack } from "./playback";

const iso = (t: number) => new Date(t).toISOString();

export default function Scrubber({
  track,
  t,
  onSeek,
  disabled,
}: {
  track: SimTrack;
  t: number;
  onSeek: (t: number) => void;
  disabled?: boolean;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const p = progressOf(track, t);

  const seekAt = (clientX: number) => {
    const rect = bar.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    onSeek(timeAtProgress(track, (clientX - rect.left) / rect.width));
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    dragging.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    seekAt(e.clientX);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (dragging.current) seekAt(e.clientX);
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    dragging.current = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const step = { ArrowRight: 0.01, ArrowUp: 0.01, ArrowLeft: -0.01, ArrowDown: -0.01, PageUp: 0.1, PageDown: -0.1 }[
      e.key
    ];
    if (step !== undefined) onSeek(timeAtProgress(track, p + step));
    else if (e.key === "Home") onSeek(track.startT);
    else if (e.key === "End") onSeek(track.endT);
    else return;
    e.preventDefault();
  };

  return (
    <div className="space-y-1.5" data-testid="sim-scrubber">
      <div
        ref={bar}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label="Replay position"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(p * 100)}
        aria-valuetext={`${fmtTime(iso(t), true)}, ${Math.round(p * 100)}% of the journey`}
        aria-disabled={disabled || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
        className={cn(
          "group relative flex h-7 touch-none select-none items-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300",
          disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
        )}
      >
        <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-slate-200">
          <div
            className="absolute inset-y-0 left-0 bg-sky-600"
            style={{ width: `${p * 100}%` }}
            data-testid="sim-progress"
          />
          {bands(track).map((b, i) => (
            <span
              key={i}
              title={b.label}
              data-band={b.kind}
              className={cn(
                "absolute inset-y-0 opacity-90",
                b.kind === "gap" ? "bg-slate-400" : b.long ? "bg-violet-500" : "bg-amber-400",
              )}
              style={{ left: `${b.from * 100}%`, width: `${Math.max(0.4, (b.to - b.from) * 100)}%` }}
            />
          ))}
        </div>
        <span
          aria-hidden
          className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-sky-700 ring-1 ring-sky-900/30 transition-transform group-active:scale-110"
          style={{ left: `${p * 100}%` }}
        />
      </div>
      <div className="flex items-center justify-between text-[11px] font-medium tabular-nums text-gray-500">
        <span>{track.points.length ? fmtTime(iso(track.startT)) : "-"}</span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
          <span className="inline-flex items-center gap-1">
            <span aria-hidden className="h-2 w-2 rounded-full bg-amber-400" /> stop
          </span>
          <span className="inline-flex items-center gap-1">
            <span aria-hidden className="h-2 w-2 rounded-full bg-violet-500" /> long stop
          </span>
          <span className="inline-flex items-center gap-1">
            <span aria-hidden className="h-2 w-2 rounded-full bg-slate-400" /> no location
          </span>
        </span>
        <span>{track.points.length ? fmtTime(iso(track.endT)) : "-"}</span>
      </div>
    </div>
  );
}
