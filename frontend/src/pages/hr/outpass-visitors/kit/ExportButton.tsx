import { FileSpreadsheet, FileText } from "lucide-react";
import { ExportMenu } from "@/components/payroll/kit/ExportMenu";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { CONTROL_H } from "./FilterBar";
import { downloadGateFile, type GateFileFormat, type GateFileQuery } from "./download";

/**
 * "Export" with two choices, Excel (.xlsx) and PDF, of what the list shows (its filters, every page). The server builds the
 * file (downloadGateFile). Downloading changes nothing, so the button stays usable for a View-only role (ExportMenu is
 * marked view-safe). A failure is a toast with the server's words (e.g. "Too many rows for one file. Narrow the dates.").
 */
export function ExportButton({
  title,
  path,
  query,
  run,
  token,
  hints,
  disabled,
  label = "Export",
  testId = "export",
  className,
}: {
  /** Names the file when the server's name cannot be read ("Gate records"). */
  title: string;
  /** The export address ("/api/gate-devices/records/export"); not needed with `run`. */
  path?: string;
  /** The list's filters (useGateFilters().exportQuery). */
  query?: GateFileQuery;
  /** Does the download itself (the gate monitor, which sends its own token); else downloadGateFile. */
  run?: (format: GateFileFormat) => Promise<unknown>;
  /** The bearer token to send instead of the HR one (see downloadGateFile). */
  token?: () => string | null;
  /** A line under each choice: "Every matching row, up to 30,000". */
  hints?: Partial<Record<GateFileFormat, string>>;
  disabled?: boolean;
  label?: string;
  /** The button's test id; the two choices are `<testId>-xlsx` and `<testId>-pdf`. */
  testId?: string;
  className?: string;
}) {
  const { toast } = useToast();
  const go = async (format: GateFileFormat) => {
    if (run) {
      await run(format);
      return;
    }
    if (!path) throw new Error("This list has no file to download yet.");
    const filename = await downloadGateFile({ path, query, format, title, token });
    toast({ title: "File downloaded", description: filename });
  };
  return (
    <ExportMenu
      label={label}
      disabled={disabled}
      testId={testId}
      className={cn(CONTROL_H, "gap-2 border-slate-200 bg-white text-slate-700 hover:bg-slate-50", className)}
      items={[
        { key: "xlsx", label: "Excel (.xlsx)", hint: hints?.xlsx, icon: FileSpreadsheet, run: () => go("xlsx") },
        { key: "pdf", label: "PDF", hint: hints?.pdf, icon: FileText, run: () => go("pdf") },
      ]}
    />
  );
}
