import { useState } from "react";
import { Button } from "@/components/ui/button";
import { SkippedPunchesDialog } from "@/components/SkippedPunchesDialog";
import { useSkippedPunches } from "@/lib/api-client/custom-hooks";
import { UserX } from "lucide-react";

/**
 * Header button for the Skipped view, carrying its own unresolved count so
 * the problem is visible without opening anything -the whole point being
 * that these punches were previously discarded with no signal at all.
 *
 * Styling follows the count: neutral at zero, amber when people are actually
 * being missed.
 */
export function SkippedPunchesButton() {
  const [open, setOpen] = useState(false);
  const { data } = useSkippedPunches(false);
  const count = data?.unresolvedCount ?? 0;

  return (
    <>
      <Button
        variant="outline"
        onClick={() => setOpen(true)}
        className={`clay-btn gap-1.5 h-9 px-3 rounded-xl border-0 shrink-0 ${
          count > 0
            ? "bg-amber-50 text-amber-700 hover:bg-amber-100"
            : "bg-slate-50 text-slate-600 hover:bg-slate-100 hover:text-slate-700"
        }`}
        title={
          count > 0
            ? `${count} device ID(s) punching with no matching employee`
            : "Every device ID matches an employee"
        }
      >
        <UserX size={14} />
        <span className="text-[13px] font-semibold">Skipped</span>
        {count > 0 && (
          <span className="ml-0.5 text-[10px] font-black px-1.5 py-0.5 rounded-full bg-amber-500 text-white">
            {count}
          </span>
        )}
      </Button>

      <SkippedPunchesDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}
