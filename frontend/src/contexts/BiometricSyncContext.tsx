import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@/lib/api-client/custom-fetch";
import { useToast } from "@/hooks/use-toast";
import {
  useSyncBiometricProgress,
  type SyncBiometricMode, type SyncDeviceId, type SyncResult, type SyncProgress,
} from "@/lib/api-client/custom-hooks";

// Mounted once at the app root (see App.tsx) -outside every routed page -so
// the sync survives navigation. Pages only ever read this context; none of
// them own the mutation or the polling, so nothing is lost when a page
// unmounts mid-sync.
interface BiometricSyncState {
  isSyncing: boolean;
  showPipeline: boolean;
  progress: SyncProgress | undefined;
  lastSyncedAt: string | null;
  triggerSync: (mode: SyncBiometricMode, deviceId: SyncDeviceId) => Promise<void>;
  dismiss: () => void;
}

const BiometricSyncCtx = createContext<BiometricSyncState | null>(null);

// Brief linger after completion so the pipeline can show its final "completed"
// tick before disappearing -kept short since the actual device work is
// already done by the time we get here.
const COMPLETION_LINGER_MS = 1000;

export function BiometricSyncProvider({ children }: { children: ReactNode }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isSyncing, setIsSyncing] = useState(false);
  const [showPipeline, setShowPipeline] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);

  const { data: progress } = useSyncBiometricProgress(showPipeline);

  // The POST no longer carries the outcome: the backend runs the sync on a
  // background thread and answers 202 immediately, because a full pull can
  // take ~5 minutes and would otherwise be killed by the server's request
  // timeout mid-sync (taking a worker down with it). The outcome arrives via
  // the progress poll instead -see the effect below.
  const triggerSync = useCallback(async (mode: SyncBiometricMode, deviceId: SyncDeviceId) => {
    setIsSyncing(true);
    setShowPipeline(true);
    try {
      const ack = await customFetch<{ ok: boolean; started: boolean; message?: string }>(
        "/api/attendance/sync-biometric",
        { method: "POST", body: JSON.stringify({ mode, deviceId }) },
      );
      if (!ack.started) {
        // Another sync (or another user's click) already holds the slot -
        // stay subscribed to the pipeline so this user still sees it finish.
        toast({ title: "Sync already running", description: ack.message });
      }
    } catch (err: any) {
      setIsSyncing(false);
      setTimeout(() => setShowPipeline(false), COMPLETION_LINGER_MS);
      toast({
        title: "Could not start sync",
        description: err?.data?.error ?? err?.message ?? "Request failed",
        variant: "destructive",
      });
    }
  }, [toast]);

  // Fires once when a run finishes: surfaces the result the POST used to
  // return, and refreshes attendance data. Keyed off the run's finishedAt so
  // a lingering "completed" snapshot can't re-toast on every 600ms poll.
  const reportedRunRef = useRef<string | null>(null);
  useEffect(() => {
    if (progress?.stage !== "completed" || !progress.finishedAt) return;
    if (reportedRunRef.current === progress.finishedAt) return;
    reportedRunRef.current = progress.finishedAt;

    setIsSyncing(false);
    setTimeout(() => setShowPipeline(false), COMPLETION_LINGER_MS);

    const result = progress.result;
    if (!result) return;

    if (result.ok) {
      setLastSyncedAt(new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }));
      const unmatched: string[] = result.unmatchedDeviceIds ?? [];
      const deviceErrors: string[] = result.deviceErrors ?? [];
      toast({
        title: `Sync complete -${result.created ?? 0} new records`,
        description: [
          unmatched.length > 0 ? `⚠ ${unmatched.length} device ID(s) had no matching employee: ${unmatched.join(", ")}` : null,
          deviceErrors.length > 0 ? `⚠ ${deviceErrors.join("; ")}` : null,
        ].filter(Boolean).join(" ") || undefined,
        variant: (unmatched.length > 0 || deviceErrors.length > 0) ? "destructive" : "default",
      });
      // Pages currently mounted (if any) pick this up immediately; pages
      // visited later just fetch fresh data on their own mount as usual.
      queryClient.invalidateQueries({
        predicate: (q) => typeof q.queryKey[0] === "string" && q.queryKey[0].startsWith("/api/attendance"),
      });
    } else {
      toast({ title: "Sync failed", description: result.error ?? "Device unreachable", variant: "destructive" });
    }
  }, [progress, toast, queryClient]);

  const dismiss = useCallback(() => setShowPipeline(false), []);

  return (
    <BiometricSyncCtx.Provider value={{ isSyncing, showPipeline, progress, lastSyncedAt, triggerSync, dismiss }}>
      {children}
    </BiometricSyncCtx.Provider>
  );
}

export function useBiometricSync(): BiometricSyncState {
  const ctx = useContext(BiometricSyncCtx);
  if (!ctx) throw new Error("useBiometricSync must be used within BiometricSyncProvider");
  return ctx;
}
