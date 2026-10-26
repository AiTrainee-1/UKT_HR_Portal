import { useMemo } from "react";
import { usePayrollSettings } from "@/lib/api-client/custom-hooks";
import { useAuth } from "@/contexts/AuthContext";
import type { ExcelContext } from "./excel";
import { branchLine } from "./logic";
import type { SheetCompany } from "./ReportSheet";

/** The company block every export carries: its name and logo from Settings, and the signed-in HR user's branch. */
export function useCompany(): { excel: ExcelContext; sheet: SheetCompany } {
  const { data: settings } = usePayrollSettings();
  const { user } = useAuth();
  const name = settings?.companyName ?? "Company";
  const logo = settings?.companyLogo ?? null;
  const branchLabel = branchLine(user?.branchName);
  return useMemo(
    () => ({
      excel: { company: name, branchLabel, logoDataUrl: logo },
      sheet: { name, branchLabel, logoUrl: logo },
    }),
    [name, branchLabel, logo],
  );
}
