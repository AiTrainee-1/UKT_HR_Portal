import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@/lib/api-client/custom-fetch";
import { useToast } from "@/hooks/use-toast";
import {
  useGeneratePayrollProgress,
  type PayrollGenerateProgress,
} from "@/lib/api-client/custom-hooks";

// Mounted once at the app root (see App.tsx) — outside every routed page — so
// payroll generation survives navigation, same pattern as BiometricSyncContext.
// Pages only ever read this context; none of them own the mutation or the
// polling, so nothing is lost when a page unmounts mid-generation.
type GeneratePayrollParams = {
  month: number;
  year: number;
  runType?: "monthly" | "biweekly" | "all";
  weekNumber?: number;
};

type GeneratePayrollResult = {
  message: string;
  generated: number;
  skipped: number;
  skippedDetails: { employeeId: number; name: string; reason: string }[];
};

interface PayrollGenerationState {
  isGenerating: boolean;
  showPipeline: boolean;
  progress: PayrollGenerateProgress | undefined;
  lastResult: GeneratePayrollResult | null;
  triggerGenerate: (params: GeneratePayrollParams) => Promise<GeneratePayrollResult | null>;
  dismiss: () => void;
}

const PayrollGenerationCtx = createContext<PayrollGenerationState | null>(null);

// Brief linger after completion so the pipeline can show its final "completed"
// state before disappearing.
const COMPLETION_LINGER_MS = 1500;

export function PayrollGenerationProvider({ children }: { children: ReactNode }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isGenerating, setIsGenerating] = useState(false);
  const [showPipeline, setShowPipeline] = useState(false);
  const [lastResult, setLastResult] = useState<GeneratePayrollResult | null>(null);

  const { data: progress } = useGeneratePayrollProgress(showPipeline);

  const triggerGenerate = useCallback(async (params: GeneratePayrollParams) => {
    setIsGenerating(true);
    setShowPipeline(true);
    try {
      const result = await customFetch<GeneratePayrollResult>("/api/payroll/generate", {
        method: "POST",
        body: JSON.stringify(params),
      });
      setIsGenerating(false);
      setLastResult(result);
      setTimeout(() => setShowPipeline(false), COMPLETION_LINGER_MS);

      const skippedCount = result.skippedDetails?.length ?? 0;
      toast({
        title: `Payroll generated — ${result.generated} record(s) computed`,
        description: skippedCount > 0
          ? `${skippedCount} employee(s) skipped. Open Generate Payroll again to see reasons.`
          : `${params.month}/${params.year} is ready.`,
        variant: skippedCount > 0 ? "destructive" : "default",
      });
      // Pages currently mounted (if any) pick this up immediately; pages
      // visited later just fetch fresh data on their own mount as usual.
      queryClient.invalidateQueries({
        predicate: (q) => typeof q.queryKey[0] === "string" && q.queryKey[0].startsWith("/api/payroll"),
      });
      return result;
    } catch (err) {
      setIsGenerating(false);
      setTimeout(() => setShowPipeline(false), COMPLETION_LINGER_MS);
      toast({
        title: "Payroll generation failed",
        description: err instanceof Error ? err.message : "Could not reach the server",
        variant: "destructive",
      });
      return null;
    }
  }, [toast, queryClient]);

  const dismiss = useCallback(() => setShowPipeline(false), []);

  return (
    <PayrollGenerationCtx.Provider value={{ isGenerating, showPipeline, progress, lastResult, triggerGenerate, dismiss }}>
      {children}
    </PayrollGenerationCtx.Provider>
  );
}

export function usePayrollGeneration(): PayrollGenerationState {
  const ctx = useContext(PayrollGenerationCtx);
  if (!ctx) throw new Error("usePayrollGeneration must be used within PayrollGenerationProvider");
  return ctx;
}
