import { Download, FileSpreadsheet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CATEGORIES, GROUP_LABEL, REQUIRED_COLUMNS, groupOf, type ColumnGroup } from "./config";
import type { Category } from "./types";

type Props = {
  category: Category;
  fileName: string;
  onDownload: () => void;
};

const ORDER: ColumnGroup[] = ["identity", "job", "pay", "bank", "personal"];

/** Step 1: the template of this kind, with the columns it has so it is clear what the sheet asks for. */
export default function TemplateCard({ category, fileName, onDownload }: Props) {
  const cfg = CATEGORIES[category];
  const grouped = ORDER.map((g) => ({ g, headers: cfg.headers.filter((h) => groupOf(h) === g) })).filter(
    (x) => x.headers.length > 0,
  );

  return (
    <div className="space-y-4" data-testid="template-card">
      <div className="flex items-start gap-3 rounded-xl border border-dashed bg-gray-50/60 p-3.5">
        <div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-lg", cfg.accent.soft)}>
          <FileSpreadsheet size={20} className={cfg.accent.text} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-gray-900" data-testid="template-file-name">
            {fileName}
          </p>
          <p className="text-xs text-gray-500">
            {cfg.headers.length} columns · 3 sample rows · an Instructions sheet. Pay is {cfg.payLine.toLowerCase()}.
          </p>
        </div>
      </div>

      <Button
        onClick={onDownload}
        className={cn("w-full gap-2 text-white", cfg.accent.solid)}
        data-testid={`download-template-${category}`}
      >
        <Download size={15} /> Download {cfg.label} template
      </Button>

      <details className="group rounded-xl border bg-white">
        <summary className="cursor-pointer list-none px-3.5 py-2.5 text-xs font-bold uppercase tracking-wide text-gray-600">
          What is in the sheet
        </summary>
        <div className="space-y-3 border-t px-3.5 py-3">
          {grouped.map(({ g, headers }) => (
            <div key={g}>
              <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-gray-500">{GROUP_LABEL[g]}</p>
              <div className="flex flex-wrap gap-1.5">
                {headers.map((h) => (
                  <span
                    key={h}
                    className={cn(
                      "rounded-md border px-2 py-0.5 text-[11px] font-medium",
                      REQUIRED_COLUMNS.has(h)
                        ? `${cfg.accent.chip} font-bold`
                        : "border-gray-200 bg-gray-50 text-gray-700",
                    )}
                  >
                    {h}
                    {REQUIRED_COLUMNS.has(h) && " *"}
                  </span>
                ))}
              </div>
            </div>
          ))}
          <p className="text-[11px] text-gray-500">
            * required. Every other column can be left blank and filled in later.
          </p>
        </div>
      </details>
    </div>
  );
}
