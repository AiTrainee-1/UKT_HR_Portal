import { Info } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { num } from "@/lib/md/format";
import type { Provenance } from "@/lib/md/types";
import { cn } from "@/lib/utils";

/**
 * "How is this calculated?": an info button that opens the explanation of a figure (where the data comes from, the
 * rule, the formula, how many records, the caveats). The same entries the assistant quotes, so a number is explained
 * the same way on the screen and in the chat. `ids` picks the entries relevant to the card; none = all of them.
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
          className={cn(
            "inline-flex h-6 w-6 items-center justify-center rounded-full text-[#006496]/55 transition-colors hover:bg-[#006496]/10 hover:text-[#006496]",
            className,
          )}
        >
          <Info size={14} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="max-h-[70vh] w-[22rem] max-w-[92vw] overflow-y-auto rounded-2xl p-0">
        <div className="border-b px-4 py-2.5 text-[11px] font-bold uppercase tracking-wider text-[#006496]/70">
          {label}
        </div>
        <div className="divide-y">
          {entries.map((p) => (
            <div key={p.id} className="space-y-1.5 px-4 py-3 text-xs" data-testid={`provenance-${p.id}`}>
              <p className="text-[13px] font-bold text-gray-900">{p.title}</p>
              <p className="text-gray-600">{p.definition}</p>
              {p.formula && (
                <p className="rounded-lg bg-slate-50 px-2.5 py-1.5 font-mono text-[11px] text-slate-700">{p.formula}</p>
              )}
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-gray-500">
                <span className="rounded-full bg-blue-50 px-2 py-0.5 font-semibold text-blue-700">{p.dataset}</span>
                {p.rows != null && <span>{num(p.rows)} records</span>}
                {p.filters.length > 0 && <span>{p.filters.join(" · ")}</span>}
              </p>
              {p.caveats.map((c, i) => (
                <p key={i} className="rounded-lg bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-900">
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
