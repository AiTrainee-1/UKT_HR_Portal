import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { customFetch } from "@/lib/api-client/custom-fetch";
import { useToast } from "@/hooks/use-toast";
import {
  useWhatsAppBulkProgress,
  type WhatsAppBulkProgress, type WhatsAppBulkResult,
} from "@/lib/api-client/custom-hooks";

// Mounted once at the app root (see App.tsx), exact same pattern as
// SalarySlipBulkContext -so a bulk WhatsApp send survives navigation away
// from the Payslip sub-tab, with its progress still visible elsewhere via
// GlobalWhatsAppBulkBanner.
type BulkWhatsAppParams = {
  month: number;
  year: number;
  employmentType?: "staff" | "production";
  weekNumber?: number;
  /** Only the slips of one production pay cycle: weekly | biweekly | monthly. */
  payCycle?: string;
};

interface WhatsAppBulkState {
  isRunning: boolean;
  showPipeline: boolean;
  progress: WhatsAppBulkProgress | undefined;
  lastResult: WhatsAppBulkResult | null;
  triggerBulkWhatsApp: (params: BulkWhatsAppParams) => Promise<WhatsAppBulkResult | null>;
  dismiss: () => void;
}

const WhatsAppBulkCtx = createContext<WhatsAppBulkState | null>(null);

const COMPLETION_LINGER_MS = 1500;

export function WhatsAppBulkProvider({ children }: { children: ReactNode }) {
  const { toast } = useToast();
  const [isRunning, setIsRunning] = useState(false);
  const [showPipeline, setShowPipeline] = useState(false);
  const [lastResult, setLastResult] = useState<WhatsAppBulkResult | null>(null);

  const { data: progress } = useWhatsAppBulkProgress(showPipeline);

  const triggerBulkWhatsApp = useCallback(async (params: BulkWhatsAppParams) => {
    setIsRunning(true);
    setShowPipeline(true);
    try {
      const result = await customFetch<WhatsAppBulkResult>("/api/salary-slips/bulk-whatsapp", {
        method: "POST",
        body: JSON.stringify(params),
      });
      setLastResult(result);
      // The slips now wait in the send queue and go out one by one within the sending limits (2026-11-06), so the
      // answer is "queued", not "delivered".
      const queued = result.queued ?? 0;
      toast({
        title: queued > 0
          ? `Salary slips queued for WhatsApp -${queued} waiting`
          : `Salary slips sent via WhatsApp -${result.sent} delivered`,
        description: result.failed > 0
          ? `${result.failed} could not be queued. See details below.`
          : result.message || "Every matching employee was messaged successfully.",
        variant: result.failed > 0 ? "destructive" : "default",
      });
      return result;
    } catch (err) {
      toast({
        title: "Bulk WhatsApp send failed",
        description: err instanceof Error ? err.message : "Could not reach the server",
        variant: "destructive",
      });
      return null;
    } finally {
      setIsRunning(false);
      setTimeout(() => setShowPipeline(false), COMPLETION_LINGER_MS);
    }
  }, [toast]);

  const dismiss = useCallback(() => setShowPipeline(false), []);

  // Memoized so the readers re-render when the send state changes, not whenever this provider does (every toast).
  const value = useMemo(
    () => ({ isRunning, showPipeline, progress, lastResult, triggerBulkWhatsApp, dismiss }),
    [isRunning, showPipeline, progress, lastResult, triggerBulkWhatsApp, dismiss],
  );

  return (
    <WhatsAppBulkCtx.Provider value={value}>
      {children}
    </WhatsAppBulkCtx.Provider>
  );
}

export function useWhatsAppBulk(): WhatsAppBulkState {
  const ctx = useContext(WhatsAppBulkCtx);
  if (!ctx) throw new Error("useWhatsAppBulk must be used within WhatsAppBulkProvider");
  return ctx;
}
