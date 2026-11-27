import { Check, SkipForward } from "lucide-react";
import { cn } from "@/lib/utils";
import { istDateTime } from "./logic";
import type { TrackerStep } from "./types";

const STATE_WORD = { done: "Done", current: "Now", pending: "Not yet", skipped: "Skipped" } as const;

/**
 * The batch's stages, read-only: done (a check, when and by whom, and what happened), the current one (what happens
 * there), the ones skipped (HR Final Settlement when the MD finalized it directly, "Finalized directly by the MD") and the
 * ones still to come. A vertical list on a phone, one row on a wide screen (as many columns as the server sends stages).
 */
export default function Tracker({ steps }: { steps: TrackerStep[] }) {
  return (
    <ol
      aria-label="Settlement progress"
      className="grid grid-cols-1 @3xl:[grid-template-columns:repeat(var(--steps),minmax(0,1fr))]"
      style={{ ["--steps" as string]: String(Math.max(steps.length, 1)) }}
      data-testid="md-settlement-tracker"
    >
      {steps.map((s, i) => {
        const done = s.state === "done";
        const current = s.state === "current";
        const skipped = s.state === "skipped";
        const last = i === steps.length - 1;
        const when = done ? istDateTime(s.at) : "";
        return (
          <li
            key={s.key}
            aria-current={current ? "step" : undefined}
            data-state={s.state}
            data-testid={`md-settlement-step-${s.key}`}
            className="relative flex gap-3 pb-4 last:pb-0 @3xl:flex-col @3xl:items-center @3xl:gap-2 @3xl:px-1 @3xl:pb-0 @3xl:text-center"
          >
            {!last && (
              <span
                aria-hidden="true"
                className={cn(
                  "absolute left-[13px] top-7 bottom-0 w-0.5 rounded-full",
                  "@3xl:left-[calc(50%+18px)] @3xl:right-[calc(-50%+18px)] @3xl:top-[13px] @3xl:bottom-auto @3xl:h-0.5 @3xl:w-auto",
                  done || skipped ? "bg-md-success-500" : "bg-md-ink/10",
                )}
              />
            )}
            <span
              className={cn(
                "relative z-[1] flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[11px] font-black",
                done && "border-md-success-600 bg-md-success-600 text-white",
                current && "border-md-wine bg-md-wine text-white ring-4 ring-md-wine/15",
                skipped && "border-dashed border-md-ink/30 bg-white/70 text-md-ink-soft",
                !done && !current && !skipped && "border-md-ink/15 bg-white/70 text-md-ink-soft",
              )}
              aria-hidden="true"
            >
              {done ? (
                <Check size={14} strokeWidth={3} />
              ) : skipped ? (
                <SkipForward size={13} strokeWidth={2.4} />
              ) : (
                i + 1
              )}
            </span>
            <div className="min-w-0 pt-0.5 @3xl:pt-0">
              <p
                className={cn(
                  "text-xs font-bold leading-snug",
                  current
                    ? "text-md-wine"
                    : skipped
                      ? "text-md-ink-soft line-through decoration-md-ink/30"
                      : "text-md-ink",
                )}
              >
                {s.label}
              </p>
              <p className="mt-0.5 text-[11px] leading-snug text-md-ink-soft">
                <span className={cn("font-bold", done && "text-md-success-700", current && "text-md-wine")}>
                  {STATE_WORD[s.state] ?? s.state}
                </span>
                {when && <span className="tabular-nums"> · {when}</span>}
              </p>
              {done && s.by && <p className="text-[11px] leading-snug text-md-ink-soft">by {s.by}</p>}
              {s.detail && (
                <p className="text-[11px] leading-snug text-md-ink" data-testid={`md-settlement-step-detail-${s.key}`}>
                  {s.detail}
                </p>
              )}
              {current && s.action && (
                <p className="mt-0.5 text-[11px] leading-snug text-md-ink @3xl:hidden">{s.action}</p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
