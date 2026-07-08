import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@/lib/api-client/custom-fetch";
import { useToast } from "@/hooks/use-toast";
import {
  useSyncBiometricProgress,
  type SyncBiometricMode, type SyncDeviceId, type SyncResult, type SyncProgress,
} from "@/lib/api-client/custom-hooks";

// Mounted once at the app root (see App.tsx) — outside every routed page — so
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
// tick before disappearing — kept short since the actual device work is
// already done by the time we get here.
const COMPLETION_LINGER_MS = 1000;

export function BiometricSyncProvider({ children }: { children: ReactNode }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isSyncing, setIsSyncing] = useState(false);
  const [showPipeline, setShowPipeline] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);

  const { data: progress } = useSyncBiometricProgress(showPipeline);

  const triggerSync = useCallback(async (mode: SyncBiometricMode, deviceId: SyncDeviceId) => {
    setIsSyncing(true);
    setShowPipeline(true);
    try {
      const result = await customFetch<SyncResult>("/api/attendance/sync-biometric", {
        method: "POST",
        body: JSON.stringify({ mode, deviceId }),
      });
      setIsSyncing(false);
      setTimeout(() => setShowPipeline(false), COMPLETION_LINGER_MS);

      if (result.ok) {
        setLastSyncedAt(new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }));
        const unmatched: string[] = result.unmatchedDeviceIds ?? [];
        const deviceErrors: string[] = result.deviceErrors ?? [];
        toast({
          title: `Sync complete — ${result.created ?? 0} new records`,
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
    } catch {
      setIsSyncing(false);
      setTimeout(() => setShowPipeline(false), COMPLETION_LINGER_MS);
      toast({ title: "Sync failed", description: "Could not reach device", variant: "destructive" });
    }
  }, [toast, queryClient]);

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
