import { History } from "lucide-react";
import { EmptyBlock } from "@/components/md/kit/states";
import { batchTitle, historyText, istDateTime, periodLabel } from "./logic";
import type { SettlementBatch } from "./types";

/** The History tab: what happened to the batch, oldest first, with who did it, when, its figures and its note. */
export default function HistoryView({ batch }: { batch: SettlementBatch }) {
  const entries = batch.history ?? [];
  return (
    <section
      className="md-card space-y-4 p-4 @2xl:p-6"
      aria-label={`History of ${batchTitle(batch)}`}
      data-testid="md-settlement-view-history"
    >
      <div>
        <h3 className="text-[15px] font-extrabold text-md-ink">
          {batchTitle(batch)} · {periodLabel(batch.month, batch.year)}
        </h3>
        <p className="mt-0.5 text-xs text-md-ink-soft">Every step of this batch, oldest first, in India's time.</p>
      </div>
      {entries.length === 0 ? (
        <EmptyBlock icon={History} title="Nothing recorded for this batch yet." />
      ) : (
        <ol className="space-y-2.5" data-testid="md-settlement-history">
          {entries.map((entry, i) => {
            const { title, facts } = historyText(entry);
            return (
              <li key={`${entry.at}-${i}`} className="md-panel flex gap-3 p-3">
                <span
                  className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-md-wine/10 text-[11px] font-black text-md-wine"
                  aria-hidden="true"
                >
                  {i + 1}
                </span>
                <div className="min-w-0 text-xs">
                  <p className="font-bold text-md-ink">{title}</p>
                  <p className="text-md-ink-soft">
                    {[entry.by, istDateTime(entry.at)].filter(Boolean).join(" · ")}
                    {facts && ` · ${facts}`}
                  </p>
                  {entry.note && <p className="mt-0.5 text-md-ink">“{entry.note}”</p>}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
