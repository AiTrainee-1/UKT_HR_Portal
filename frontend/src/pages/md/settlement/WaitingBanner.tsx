import { BellRing } from "lucide-react";
import { waitingSentence, type WaitingGroup } from "./logic";

/** Batches waiting for the MD in another month or of the other type than the one on screen ("Term Loan · Batch 1 waiting
 *  in October 2026"), each with a button that opens that type and month. */
export default function WaitingBanner({
  groups,
  onOpen,
}: {
  groups: WaitingGroup[];
  onOpen: (group: WaitingGroup) => void;
}) {
  if (groups.length === 0) return null;
  return (
    <div className="md-panel-wine flex items-start gap-3 p-3.5" data-testid="md-settlement-waiting-banner">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-md-wine text-white">
        <BellRing size={15} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-extrabold text-md-ink">Also waiting for your decision</p>
        <ul className="mt-1.5 space-y-2">
          {groups.map((w) => (
            <li key={`${w.type}-${w.key}`} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
              <p className="min-w-0 text-[13px] font-semibold leading-snug text-md-ink">{waitingSentence(w)}</p>
              <button
                type="button"
                className="md-btn md-btn-primary md-btn-sm"
                onClick={() => onOpen(w)}
                aria-label={`Open ${w.typeLabel}, ${w.period}`}
                data-testid={`md-settlement-open-${w.type}-${w.key}`}
              >
                Open
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
