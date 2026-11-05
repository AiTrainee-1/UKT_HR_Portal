import { memo, useCallback, useState, useSyncExternalStore } from "react";
import { useQueryClient, type QueryCache } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { runPageRefreshers } from "@/lib/page-refresh";

const newestActiveData = (cache: QueryCache) =>
  cache.findAll({ type: "active" }).reduce((newest, q) => Math.max(newest, q.state.dataUpdatedAt), 0);

type LastUpdatedStore = {
  value: number;
  listeners: Set<() => void>;
  unsubscribe: (() => void) | null;
  frame: number;
};
const lastUpdatedStores = new WeakMap<QueryCache, LastUpdatedStore>();

const nextFrame = (cb: () => void): number =>
  typeof requestAnimationFrame === "function" ? requestAnimationFrame(cb) : window.setTimeout(cb, 16);
const cancelFrame = (handle: number) =>
  typeof cancelAnimationFrame === "function" ? cancelAnimationFrame(handle) : window.clearTimeout(handle);

/**
 * One shared watcher per query cache. The cache emits an event for every fetch, result and observer change (dozens a
 * second on a busy page), and walking every query on each of them was measurable; this recomputes at most once per
 * frame, and only tells its readers when the time actually changed.
 */
function lastUpdatedStore(cache: QueryCache): LastUpdatedStore {
  let store = lastUpdatedStores.get(cache);
  if (!store) {
    store = { value: 0, listeners: new Set(), unsubscribe: null, frame: 0 };
    lastUpdatedStores.set(cache, store);
  }
  return store;
}

function subscribeLastUpdated(cache: QueryCache, onChange: () => void): () => void {
  const store = lastUpdatedStore(cache);
  store.listeners.add(onChange);
  if (!store.unsubscribe) {
    store.value = newestActiveData(cache);
    const recompute = () => {
      store.frame = 0;
      const value = newestActiveData(cache);
      if (value === store.value) return;
      store.value = value;
      store.listeners.forEach((listener) => listener());
    };
    store.unsubscribe = cache.subscribe(() => {
      if (!store.frame) store.frame = nextFrame(recompute);
    });
  }
  return () => {
    store.listeners.delete(onChange);
    if (store.listeners.size > 0) return;
    store.unsubscribe?.();
    store.unsubscribe = null;
    if (store.frame) cancelFrame(store.frame);
    store.frame = 0;
  };
}

/** When the newest data on screen arrived (0 = nothing loaded yet). */
function useLastUpdated(): number {
  const queryClient = useQueryClient();
  const cache = queryClient.getQueryCache();
  // Stable, so a re-render (a Refresh button in a page's title row re-renders with every keystroke there) does not
  // unsubscribe and subscribe again.
  const subscribe = useCallback((onChange: () => void) => subscribeLastUpdated(cache, onChange), [cache]);
  const getSnapshot = useCallback(() => {
    const store = lastUpdatedStore(cache);
    // Live while someone is subscribed; before the first subscription (the first render) it is computed fresh.
    return store.unsubscribe ? store.value : newestActiveData(cache);
  }, [cache]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

export const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", second: "2-digit" });

/** Reloads everything on the page in place; `busy` is true while it does. (The MD portal's page header uses it too.) */
export function useRefreshAction() {
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

  return { refresh, busy, lastUpdated };
}

/**
 * The Refresh button itself. Put it in a page's title row (right side, beside the page's other
 * actions) and add that page to the skip list in lib/page-refresh.ts so the layout doesn't show a
 * second one. Filters, tabs and open dialogs stay as they are; hovering says when the data loaded.
 */
export function RefreshButton({ className = "" }: { className?: string }) {
  const { refresh, busy, lastUpdated } = useRefreshAction();
  return (
    <Button
      variant="outline"
      size="sm"
      className={`gap-2 ${className}`}
      onClick={refresh}
      disabled={busy}
      aria-label="Refresh this page"
      title={lastUpdated ? `Data last loaded at ${clock(lastUpdated)}` : "Reload the data on this page"}
      data-testid="button-page-refresh"
    >
      <RefreshCw size={14} className={busy ? "animate-spin" : ""} /> Refresh
    </Button>
  );
}

/**
 * The strip HrLayout shows at the top of every HR page that doesn't put its own RefreshButton in its
 * title row (see lib/page-refresh.ts): "Updated 3:47:23 pm" and the button.
 */
function PageRefreshBar() {
  const { lastUpdated } = useRefreshAction();
  return (
    <div className="mb-3 flex items-center justify-end gap-3 print:hidden" data-testid="page-refresh-bar">
      {lastUpdated > 0 && (
        <span className="text-[11px] tabular-nums text-gray-400" data-testid="page-last-updated">
          Updated {clock(lastUpdated)}
        </span>
      )}
      <RefreshButton />
    </div>
  );
}

// No props: re-renders only when its own data changes, not on every render of the page around it.
export default memo(PageRefreshBar);
