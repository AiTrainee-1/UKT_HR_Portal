import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { customFetch } from "@/lib/api-client/custom-fetch";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import {
  useSalarySlipBulkProgress, downloadDocumentPdf,
  type SalarySlipBulkProgress, type SalarySlipBulkEmailResult,
} from "@/lib/api-client/custom-hooks";

// Mounted once at the app root (see App.tsx), same pattern as
// PayrollGenerationContext — so a bulk download/email survives navigation
// away from the Salary Slip page, and its progress can still be shown via
// GlobalSalarySlipBulkBanner elsewhere in the app.
type BulkSlipParams = {
  month: number;
  year: number;
  employmentType?: "staff" | "production";
  weekNumber?: number;
};

interface SalarySlipBulkState {
  isRunning: boolean;
  kind: "pdf" | "email" | null;
  showPipeline: boolean;
  progress: SalarySlipBulkProgress | undefined;
  lastEmailResult: SalarySlipBulkEmailResult | null;
  triggerBulkDownload: (params: BulkSlipParams) => Promise<void>;
  triggerBulkEmail: (params: BulkSlipParams) => Promise<SalarySlipBulkEmailResult | null>;
  dismiss: () => void;
}

const SalarySlipBulkCtx = createContext<SalarySlipBulkState | null>(null);

// Brief linger after completion so the pipeline can show its final state
// before disappearing — same value used by PayrollGenerationContext.
const COMPLETION_LINGER_MS = 1500;

function buildQuery(params: BulkSlipParams): string {
  const qs = new URLSearchParams();
  qs.set("month", String(params.month));
  qs.set("year", String(params.year));
  if (params.employmentType) qs.set("employmentType", params.employmentType);
  if (params.weekNumber) qs.set("weekNumber", String(params.weekNumber));
  return qs.toString();
}

export function SalarySlipBulkProvider({ children }: { children: ReactNode }) {
  const { toast } = useToast();
  const { token } = useAuth();
  const [isRunning, setIsRunning] = useState(false);
  const [kind, setKind] = useState<"pdf" | "email" | null>(null);
  const [showPipeline, setShowPipeline] = useState(false);
  const [lastEmailResult, setLastEmailResult] = useState<SalarySlipBulkEmailResult | null>(null);

  const { data: progress } = useSalarySlipBulkProgress(showPipeline);

  const triggerBulkDownload = useCallback(async (params: BulkSlipParams) => {
    setIsRunning(true);
    setKind("pdf");
    setShowPipeline(true);
    try {
      await downloadDocumentPdf(`/api/salary-slips/bulk-pdf?${buildQuery(params)}`, () => token);
      toast({
        title: "Salary slips downloaded",
        description: "Combined PDF ready — 2 slips per A4 page, in one file.",
      });
    } catch (err) {
      toast({
        title: "Bulk download failed",
        description: err instanceof Error ? err.message : "Could not reach the server",
        variant: "destructive",
      });
    } finally {
      setIsRunning(false);
      setTimeout(() => setShowPipeline(false), COMPLETION_LINGER_MS);
    }
  }, [token, toast]);

  const triggerBulkEmail = useCallback(async (params: BulkSlipParams) => {
    setIsRunning(true);
    setKind("email");
    setShowPipeline(true);
    try {
      const result = await customFetch<SalarySlipBulkEmailResult>("/api/salary-slips/bulk-email", {
        method: "POST",
        body: JSON.stringify(params),
      });
      setLastEmailResult(result);
      toast({
        title: `Salary slips emailed — ${result.sent} delivered`,
        description: result.failed > 0
          ? `${result.failed} failed to send. See details on the page.`
          : "Every matching employee was emailed successfully.",
        variant: result.failed > 0 ? "destructive" : "default",
      });
      return result;
    } catch (err) {
      toast({
        title: "Bulk email failed",
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

  return (
    <SalarySlipBulkCtx.Provider value={{
      isRunning, kind, showPipeline, progress, lastEmailResult,
      triggerBulkDownload, triggerBulkEmail, dismiss,
    }}>
      {children}
    </SalarySlipBulkCtx.Provider>
  );
}

export function useSalarySlipBulk(): SalarySlipBulkState {
  const ctx = useContext(SalarySlipBulkCtx);
  if (!ctx) throw new Error("useSalarySlipBulk must be used within SalarySlipBulkProvider");
  return ctx;
}
