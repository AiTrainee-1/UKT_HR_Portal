import { useRef, useState, type RefObject } from "react";
import { FileImage, FileSpreadsheet, FileText, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { downloadWorkbook, exportElementToFile, fileSafe } from "@/lib/exportUtils";
import { cn } from "@/lib/utils";
import { buildSheetWorkbook, sheetFileName, type ExcelContext } from "./excel";
import type { SheetSpec } from "./sheets";

export type ExportFormat = "excel" | "pdf" | "image";

/** Excel / PDF / Image of one list. The PDF and the picture are taken from the off-screen copy of the sheet (`sheetRef`), the
 *  Excel file is built from the same spec. */
export function useSheetExport(spec: SheetSpec, context: ExcelContext) {
  const { toast } = useToast();
  const sheetRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState<ExportFormat | null>(null);

  const run = async (format: ExportFormat) => {
    if (busy) return;
    setBusy(format);
    try {
      if (format === "excel") {
        await downloadWorkbook(buildSheetWorkbook(spec, context), sheetFileName(spec));
      } else {
        if (!sheetRef.current) throw new Error("The sheet is not on screen");
        await exportElementToFile(sheetRef.current, fileSafe(spec.title), format === "image" ? "png" : "pdf");
      }
    } catch {
      toast({
        title: `Failed to export ${format === "excel" ? "Excel" : format === "pdf" ? "PDF" : "image"}`,
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  };

  return { sheetRef: sheetRef as RefObject<HTMLDivElement>, busy, run };
}

const FORMATS: { format: ExportFormat; label: string; Icon: typeof FileText; tone: string }[] = [
  {
    format: "excel",
    label: "Excel",
    Icon: FileSpreadsheet,
    tone: "border-green-200 text-green-700 hover:bg-green-50 hover:text-green-800",
  },
  {
    format: "pdf",
    label: "PDF",
    Icon: FileText,
    tone: "border-red-200 text-red-700 hover:bg-red-50 hover:text-red-800",
  },
  {
    format: "image",
    label: "Image",
    Icon: FileImage,
    tone: "border-indigo-200 text-indigo-700 hover:bg-indigo-50 hover:text-indigo-800",
  },
];

/** The three download buttons. Reading a list out changes nothing, so the MD's View Only lock leaves them alone. */
export default function ExportBar({
  busy,
  onExport,
  disabled,
  disabledHint,
  formats = ["excel", "pdf", "image"],
  scope,
}: {
  busy: ExportFormat | null;
  onExport: (format: ExportFormat) => void;
  disabled: boolean;
  /** Why the buttons are off (a tooltip). */
  disabledHint?: string;
  /** Which downloads to offer (the Daily Late Report has no picture). */
  formats?: ExportFormat[];
  /** What a download contains right now ("Exporting 5 selected"), added to each button's hover text. */
  scope?: string;
}) {
  return (
    <div className="flex items-center gap-2" data-view-safe data-testid="export-bar">
      {FORMATS.filter((f) => formats.includes(f.format)).map(({ format, label, Icon, tone }) => (
        <Button
          key={format}
          type="button"
          variant="outline"
          className={cn("h-10 gap-1.5 font-semibold", tone)}
          disabled={disabled || busy !== null}
          title={
            disabled ? disabledHint : scope ? `Download as ${label}: ${scope.toLowerCase()}` : `Download as ${label}`
          }
          onClick={() => onExport(format)}
          data-view-safe
          data-testid={`export-${format}`}
        >
          {busy === format ? <Loader2 size={14} className="animate-spin" /> : <Icon size={14} />}
          {busy === format ? "Exporting…" : label}
        </Button>
      ))}
    </div>
  );
}
