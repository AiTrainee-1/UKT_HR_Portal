import { useState } from "react";
import { Loader2, LockOpen, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/** The fewest characters a reason for unlocking may have (the server asks for a few words too). */
export const UNLOCK_REASON_MIN = 3;
export const UNLOCK_REASON_MAX = 500;

/**
 * Unlock a finalized payroll (owner 2026-11-16: "once finalized, payroll should not be regenerated unless it is explicitly
 * unlocked; once payment is completed, the payroll should remain locked"), shared by the Staff month and the Production
 * pay period popups. Shows, for a finalized payroll:
 *   - nothing to press and the reason when it is paid (`blocked`: "Paid: locked for good ...");
 *   - otherwise an Unlock button that asks for a short reason, then calls `onUnlock(reason)`.
 * `what` names it in the sentences ("this pay period", "this month").
 */
export function UnlockPanel({
  what,
  blocked,
  allowed,
  busy,
  onUnlock,
}: {
  what: string;
  blocked: string | null | undefined;
  allowed: boolean;
  busy: boolean;
  onUnlock: (reason: string) => Promise<boolean>;
}) {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const clean = reason.trim();

  if (blocked) {
    return (
      <p
        className="flex items-start gap-1.5 rounded-xl border border-emerald-200 bg-emerald-50/70 p-2.5 text-xs text-emerald-900"
        data-testid="unlock-blocked"
      >
        <ShieldCheck size={13} className="mt-0.5 shrink-0 text-emerald-600" />
        {blocked}
      </p>
    );
  }
  if (!allowed) return null;
  if (!asking) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50 p-2.5 text-xs text-slate-700">
        <span>Need to change it? Unlock {what} to generate and work it out again (nothing is paid yet).</span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 gap-1.5 border-violet-200 text-violet-700 hover:bg-violet-50"
          onClick={() => setAsking(true)}
          data-testid="unlock-open"
        >
          <LockOpen size={13} /> Unlock
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-2 rounded-xl border border-violet-200 bg-violet-50/70 p-3 text-xs text-violet-950">
      <p className="font-semibold">
        Unlock {what}? It goes back to Generated: it can be generated, worked out again and adjusted, and Payroll Done
        must be pressed again before it is paid.
      </p>
      <label className="block space-y-1">
        <span className="font-semibold text-gray-700">Why are you unlocking it?</span>
        <Textarea
          value={reason}
          maxLength={UNLOCK_REASON_MAX}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
          placeholder="For example: attendance corrected for two workers"
          className="bg-white text-sm"
          data-testid="unlock-reason"
        />
      </label>
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            setAsking(false);
            setReason("");
          }}
          data-testid="unlock-cancel"
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          className="gap-1.5 bg-violet-600 font-bold text-white hover:bg-violet-700"
          disabled={busy || clean.length < UNLOCK_REASON_MIN}
          onClick={async () => {
            if (await onUnlock(clean)) {
              setAsking(false);
              setReason("");
            }
          }}
          data-testid="unlock-yes"
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <LockOpen size={13} />} Yes, unlock
        </Button>
      </div>
    </div>
  );
}
