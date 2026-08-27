import { useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  useSkippedPunches, useResolveSkippedPunch, type SkippedPunch,
} from "@/lib/api-client/custom-hooks";
import { UserX, Check, Info, Eye, EyeOff } from "lucide-react";

/**
 * Device user IDs that punched but match no employee -i.e. real people
 * clocking in whose attendance is being silently discarded.
 *
 * Before this existed the same information was written only to the server
 * log, which meant nobody ever saw it: someone could punch every day for
 * weeks and simply not be recorded, with no signal anywhere in the portal.
 */
export function SkippedPunchesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const [includeResolved, setIncludeResolved] = useState(false);
  const { data, isLoading } = useSkippedPunches(includeResolved);
  const resolve = useResolveSkippedPunch();
  const [noteFor, setNoteFor] = useState<number | null>(null);
  const [note, setNote] = useState("");

  const rows = data?.results ?? [];

  const handleResolve = (row: SkippedPunch) => {
    resolve.mutate(
      { id: row.id, note: noteFor === row.id ? note.trim() : undefined },
      {
        onSuccess: () => {
          toast({
            title: `Marked ${row.deviceUserId} as handled`,
            description: "It'll reappear here if that ID punches again.",
          });
          setNoteFor(null);
          setNote("");
        },
        onError: (e: any) =>
          toast({ title: "Could not update", description: e?.message, variant: "destructive" }),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserX size={16} className="text-amber-600" /> Skipped punches
          </DialogTitle>
        </DialogHeader>

        <div className="flex gap-2 items-start rounded-lg bg-amber-50 border border-amber-200 p-2.5 text-[11px] leading-relaxed text-amber-900">
          <Info size={13} className="mt-0.5 shrink-0" />
          <span>
            These IDs punched on a biometric device but match no employee code in the portal,
            so <b>their attendance is not being recorded</b>. Fix by adding the employee with
            that exact code, or correcting whichever side has the wrong code.
          </span>
        </div>

        {data && data.unresolvedCount > 0 && (
          <p className="text-xs text-muted-foreground">
            <b className="text-amber-700">{data.unresolvedCount}</b> unresolved ID
            {data.unresolvedCount === 1 ? "" : "s"} ·{" "}
            <b className="text-amber-700">{data.discardedPunches}</b> punch
            {data.discardedPunches === 1 ? "" : "es"} discarded so far
          </p>
        )}

        <div className="flex justify-end">
          <Button
            variant="ghost" size="sm" className="gap-1.5 h-7 text-[11px]"
            onClick={() => setIncludeResolved((v) => !v)}
          >
            {includeResolved ? <EyeOff size={12} /> : <Eye size={12} />}
            {includeResolved ? "Hide handled" : "Show handled too"}
          </Button>
        </div>

        <div className="max-h-[45vh] overflow-y-auto space-y-2 pr-1">
          {isLoading ? (
            Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-14 rounded-lg" />)
          ) : rows.length === 0 ? (
            <div className="py-10 text-center">
              <Check size={26} className="text-green-500 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">
                No skipped punches — every device ID matches an employee.
              </p>
            </div>
          ) : (
            rows.map((row) => (
              <div
                key={row.id}
                className={`rounded-lg border p-3 ${row.resolved ? "bg-gray-50 opacity-70" : "bg-white"}`}
              >
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono font-bold text-sm">{row.deviceUserId}</span>
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">
                        {row.punchCount} punch{row.punchCount === 1 ? "" : "es"} discarded
                      </span>
                      {row.resolved && (
                        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-green-50 text-green-700">
                          Handled
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-1">
                      {row.deviceLabel ?? row.deviceSerial ?? "unknown device"}
                      {row.lastPunchDate && ` · last punch ${row.lastPunchDate} ${row.lastPunchTime ?? ""}`}
                    </p>
                    {row.resolvedNote && (
                      <p className="text-[11px] text-gray-400 mt-0.5 italic">{row.resolvedNote}</p>
                    )}
                  </div>

                  {!row.resolved && (
                    <div className="flex items-center gap-2 shrink-0">
                      {noteFor === row.id ? (
                        <>
                          <Input
                            autoFocus
                            value={note}
                            onChange={(e) => setNote(e.target.value)}
                            placeholder="Optional note"
                            className="h-8 text-xs w-44"
                          />
                          <Button
                            size="sm" className="h-8 text-xs"
                            disabled={resolve.isPending}
                            onClick={() => handleResolve(row)}
                          >
                            Save
                          </Button>
                        </>
                      ) : (
                        <Button
                          size="sm" variant="outline" className="h-8 gap-1.5 text-xs"
                          onClick={() => { setNoteFor(row.id); setNote(""); }}
                        >
                          <Check size={12} /> Mark handled
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
