import { Info } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { num } from "@/lib/md/format";
import type { Provenance } from "@/lib/md/types";
import { cn } from "@/lib/utils";

/**
 * "How is this calculated?": an info button that opens the explanation of a figure (where the data comes from, the
 * rule, the formula, how many records, the caveats). The same entries the assistant quotes, so a number is explained
 * the same way on the screen and in the chat. `ids` picks the entries relevant to the card; none = all of them.
 * The popover is strong glass (md-theme areas/shell.css).
 */
export default function ProvenanceButton({
  provenance,
  ids,
  className,
  label = "How is this calculated?",
}: {
  provenance: Provenance[] | undefined;
  ids?: string[];
  className?: string;
  label?: string;
}) {
  const entries = (provenance ?? []).filter((p) => !ids || ids.includes(p.id));
  if (entries.length === 0) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          title={label}
          data-testid="provenance-button"
          className={cn("md-shell-info", className)}
        >
          <Info size={15} strokeWidth={2} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="md-shell-popover max-h-[70vh] w-[22rem] max-w-[92vw] overflow-y-auto"
      >
        <div className="flex items-center gap-2 border-b border-md-line px-4 py-3">
          <span className="md-icon-tile h-6 w-6 shrink-0 rounded-lg">
            <Info size={13} strokeWidth={2.2} />
          </span>
          <span className="md-shell-overline text-md-wine">{label}</span>
        </div>
        <div className="divide-y divide-md-line">
          {entries.map((p) => (
            <div key={p.id} className="space-y-2 px-4 py-3.5 text-xs" data-testid={`provenance-${p.id}`}>
              <p className="text-[13px] font-bold text-md-ink">{p.title}</p>
              <p className="leading-relaxed text-md-ink-soft">{p.definition}</p>
              {p.formula && (
                <p className="rounded-xl border border-md-line bg-md-ink/[0.045] px-2.5 py-1.5 font-mono text-[11px] text-md-ink">
                  {p.formula}
                </p>
              )}
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[11px] text-md-ink-soft">
                <span className="md-chip md-chip-wine">{p.dataset}</span>
                {p.rows != null && <span>{num(p.rows)} records</span>}
                {p.filters.length > 0 && <span>{p.filters.join(" · ")}</span>}
              </p>
              {p.caveats.map((c, i) => (
                <p key={i} className="md-panel-sand px-2.5 py-1.5 text-[11px] leading-relaxed text-md-warning-800">
                  {c}
                </p>
              ))}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
