import { ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AnswerPayload, Confidence } from "./api";

/** Good / watch / bad, in the portal's meaning of those colours (sage, ochre, crimson). The words carry it as well. */
const CONFIDENCE: Record<Confidence, { label: string; chip: string; icon: typeof ShieldCheck }> = {
  high: { label: "High confidence", chip: "md-chip-success", icon: ShieldCheck },
  medium: { label: "Medium confidence", chip: "md-chip-warning", icon: ShieldAlert },
  low: { label: "Low confidence", chip: "md-chip-danger", icon: ShieldX },
};

/** How sure the answer is, as a small chip beside Listen and Copy (the reason shows on hover). */
export function ConfidenceChip({ payload }: { payload: AnswerPayload }) {
  if (!payload.confidence) return null;
  const c = CONFIDENCE[payload.confidence];
  return (
    <span className={cn("md-chip", c.chip)} title={payload.confidenceReason} data-testid="assistant-confidence">
      <c.icon size={11} aria-hidden />
      {c.label}
    </span>
  );
}
