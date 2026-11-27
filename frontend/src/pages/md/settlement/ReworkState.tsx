import { CornerUpLeft, RefreshCcw } from "lucide-react";
import { istDateTime, lastHistory, mdRoundOf, plural, reviewOf } from "./logic";
import { Quote } from "./parts";
import type { SettlementBatch } from "./types";

/**
 * Where the batch stands in the rework loop (owner 2026-11-27), above the requests and on the Overview:
 * - HR Rework (MD Changes): read-only - "Returned to HR for rework - waiting for HR to resubmit", when, how many requests
 *   HR is answering, and the MD's instructions;
 * - MD Review, round 2+: "Revised settlement - round N", when HR resubmitted it, how many requests need the MD's look
 *   again (HR's revised proposals come pre-filled; the rest keep the MD's decision), HR's note and the MD's earlier
 *   instructions.
 * Nothing in round 1 of MD Review or at any other stage.
 */
export default function ReworkState({ batch }: { batch: SettlementBatch }) {
  const round = mdRoundOf(batch);
  const back = batch.flow?.mdReturn ?? null;

  if (batch.stage === "md_changes") {
    const returned = lastHistory(batch, "md_returned");
    const at = back?.at ?? returned?.at ?? null;
    const by = back?.by ?? returned?.by ?? null;
    const note = (back?.note ?? returned?.note ?? "").trim();
    const flagged = batch.counts.rework ?? batch.items.filter((i) => i.rework).length;
    return (
      <div className="md-panel-sand space-y-1.5 p-3.5" role="status" data-testid="md-settlement-returned">
        <p className="flex items-center gap-1.5 text-[13px] font-extrabold text-md-warning-800">
          <CornerUpLeft size={15} aria-hidden="true" className="shrink-0" />
          Returned to HR for rework — waiting for HR to resubmit
        </p>
        <p className="text-xs leading-relaxed text-md-ink-soft">
          {at ? `You returned it on ${istDateTime(at)}${by ? ` (${by})` : ""}. ` : ""}
          {flagged > 0
            ? `HR is answering ${plural(flagged, "request")} you changed or remarked on. `
            : "HR is working through your instructions. "}
          It comes back to you for approval when HR resubmits it. Read-only until then.
        </p>
        {note && (
          <Quote label="Your instructions" testId="md-settlement-returned-note">
            {note}
          </Quote>
        )}
      </div>
    );
  }

  if (batch.stage !== "md_review" || round < 2) return null;
  const resubmitted = lastHistory(batch, "md_resubmitted");
  const again = batch.items.filter((i) => reviewOf(i, batch.stage) === "pending").length;
  const hrNote = (resubmitted?.note ?? "").trim();
  const mine = (back?.note ?? "").trim();
  return (
    <div className="md-panel-wine space-y-1.5 p-3.5" role="status" data-testid="md-settlement-round">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] font-extrabold text-md-ink">
        <RefreshCcw size={15} aria-hidden="true" className="shrink-0 text-md-wine" />
        Revised settlement — round {round}
        <span className="md-chip md-chip-wine" data-testid="md-settlement-round-again">
          {again > 0 ? `${plural(again, "request")} to look at again` : "Nothing new to decide"}
        </span>
      </p>
      <p className="text-xs leading-relaxed text-md-ink-soft">
        {resubmitted?.at
          ? `HR resubmitted it on ${istDateTime(resubmitted.at)}${resubmitted.by ? ` (${resubmitted.by})` : ""}. `
          : "HR resubmitted it. "}
        {again > 0
          ? "HR's revised proposals come pre-filled at the top: confirm or change them. The other requests keep your decision."
          : "Every request keeps your decision: approve the settlement, or return it again."}{" "}
        No changes: approve it. Changes or corrections: return it to HR again.
      </p>
      {hrNote && (
        <Quote label="HR's note" testId="md-settlement-round-hr-note">
          {hrNote}
        </Quote>
      )}
      {mine && (
        <Quote label={`Your instructions (round ${round - 1})`} testId="md-settlement-round-your-note">
          {mine}
        </Quote>
      )}
    </div>
  );
}
