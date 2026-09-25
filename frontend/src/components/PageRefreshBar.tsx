import { useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { runPageRefreshers } from "@/lib/page-refresh";

/** When the newest data on screen arrived (0 = nothing loaded yet). */
function useLastUpdated(): number {
  const queryClient = useQueryClient();
  const cache = queryClient.getQueryCache();
  return useSyncExternalStore(
    (onChange) => cache.subscribe(onChange),
    () => cache.findAll({ type: "active" }).reduce((newest, q) => Math.max(newest, q.state.dataUpdatedAt), 0),
  );
}

/**
 * The Refresh button every HR page gets (HrLayout shows it, except on the pages listed in
 * lib/page-refresh.ts). It reloads all the data on the page in place -filters, tabs and open
 * dialogs stay as they are- and says when the data was last loaded.
 */
export default function PageRefreshBar() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const lastUpdated = useLastUpdated();

  const refresh = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // Refetches every query on screen (and marks the rest stale), plus pages that load by hand.
      await Promise.all([queryClient.invalidateQueries(), runPageRefreshers()]);
      const failed = queryClient
        .getQueryCache()
        .findAll({ type: "active" })
        .some((q) => q.state.status === "error" && q.state.fetchStatus === "idle");
      if (failed) {
        toast({
          title: "Couldn't refresh everything",
          description: "Some data didn't load. Check your connection and try again.",
          variant: "destructive",
        });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-3 flex items-center justify-end gap-3 print:hidden" data-testid="page-refresh-bar">
      {lastUpdated > 0 && (
        <span className="text-[11px] tabular-nums text-gray-400" data-testid="page-last-updated">
          Updated{" "}
          {new Date(lastUpdated).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", second: "2-digit" })}
        </span>
      )}
      <Button
        variant="outline"
        size="sm"
        className="gap-2"
        onClick={refresh}
        disabled={busy}
        aria-label="Refresh this page"
        data-testid="button-page-refresh"
      >
        <RefreshCw size={14} className={busy ? "animate-spin" : ""} /> Refresh
      </Button>
    </div>
  );
}
