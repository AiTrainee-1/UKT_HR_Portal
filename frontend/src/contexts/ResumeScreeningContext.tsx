import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@/lib/api-client/custom-fetch";
import { useToast } from "@/hooks/use-toast";
import {
  useResumeScreeningProgress,
  type ResumeScreeningProgress,
} from "@/lib/api-client/custom-hooks";

// Mounted once at the app root (see App.tsx) — outside every routed page — so
// bulk resume screening survives navigation, same pattern as
// PayrollGenerationContext/BiometricSyncContext. Pages only ever read this
// context; none of them own the mutation or the polling, so nothing is lost
// when a page unmounts mid-run.
type TriggerBulkScreenParams = {
  files: File[];
  ruleSetId: number;
  topN: number;
};

type BulkScreenResult = {
  message: string;
  totalUploaded: number;
  shortlisted: number;
  notShortlisted: number;
  failed: { filename: string; error: string }[];
};

interface ResumeScreeningState {
  isScreening: boolean;
  showPipeline: boolean;
  progress: ResumeScreeningProgress | undefined;
  lastResult: BulkScreenResult | null;
  triggerBulkScreen: (params: TriggerBulkScreenParams) => Promise<BulkScreenResult | null>;
  dismiss: () => void;
}

const ResumeScreeningCtx = createContext<ResumeScreeningState | null>(null);

const COMPLETION_LINGER_MS = 1500;

export function ResumeScreeningProvider({ children }: { children: ReactNode }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isScreening, setIsScreening] = useState(false);
  const [showPipeline, setShowPipeline] = useState(false);
  const [lastResult, setLastResult] = useState<BulkScreenResult | null>(null);

  const { data: progress } = useResumeScreeningProgress(showPipeline);

  const triggerBulkScreen = useCallback(async ({ files, ruleSetId, topN }: TriggerBulkScreenParams) => {
    setIsScreening(true);
    setShowPipeline(true);
    try {
      const formData = new FormData();
      files.forEach(f => formData.append("files", f));
      formData.append("ruleSetId", String(ruleSetId));
      formData.append("topN", String(topN));

      const result = await customFetch<BulkScreenResult>("/api/recruitment/resume-screening/upload-bulk", {
        method: "POST",
        body: formData,
      });
      setIsScreening(false);
      setLastResult(result);
      setTimeout(() => setShowPipeline(false), COMPLETION_LINGER_MS);

      toast({
        title: `Screening complete — ${result.shortlisted} shortlisted`,
        description: [
          `${result.notShortlisted} not shortlisted`,
          result.failed.length > 0 ? `⚠ ${result.failed.length} file(s) failed to process` : null,
        ].filter(Boolean).join(", "),
        variant: result.failed.length > 0 ? "destructive" : "default",
      });
      queryClient.invalidateQueries({
        predicate: (q) => typeof q.queryKey[0] === "string" && q.queryKey[0].startsWith("/api/recruitment/resume-screening"),
      });
      return result;
    } catch (err) {
      setIsScreening(false);
      setTimeout(() => setShowPipeline(false), COMPLETION_LINGER_MS);
      toast({
        title: "Resume screening failed",
        description: err instanceof Error ? err.message : "Could not reach the server",
        variant: "destructive",
      });
      return null;
    }
  }, [toast, queryClient]);

  const dismiss = useCallback(() => setShowPipeline(false), []);

  return (
    <ResumeScreeningCtx.Provider value={{ isScreening, showPipeline, progress, lastResult, triggerBulkScreen, dismiss }}>
      {children}
    </ResumeScreeningCtx.Provider>
  );
}

export function useResumeScreening(): ResumeScreeningState {
  const ctx = useContext(ResumeScreeningCtx);
  if (!ctx) throw new Error("useResumeScreening must be used within ResumeScreeningProvider");
  return ctx;
}
