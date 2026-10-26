import { FileSpreadsheet, FileText, Info, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { CoverageFileFormat, PfEsiClass } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { STRIP_COLUMNS, notEvaluatedNote, type StripRow } from "./logic";

/**
 * "How many employees have PF/ESI deducted and how many do not", per class, from GET /api/pf-esi/coverage. Each class row is
 * also a shortcut to that class's pill below. The two Download buttons fetch the same report as a file.
 */
export function CoverageStrip({
  rows,
  loading,
  failed,
  onRetry,
  selected,
  onSelect,
  onDownload,
  downloading,
}: {
  rows: StripRow[];
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  selected: PfEsiClass;
  onSelect: (cls: PfEsiClass) => void;
  onDownload: (format: CoverageFileFormat) => void;
  /** The format being prepared, or null. */
  downloading: CoverageFileFormat | null;
}) {
  const note = notEvaluatedNote(rows);
  return (
    <Card data-testid="coverage-strip">
      <CardContent className="space-y-2 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold text-gray-900">PF / ESI coverage</h3>
            <p className="text-xs text-muted-foreground">
              Active employees. PF and ESI apply only to employees with the Co Emp switch on.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={downloading !== null}
              onClick={() => onDownload("xlsx")}
              data-testid="coverage-download-xlsx"
            >
              {downloading === "xlsx" ? (
                <Loader2 size={14} className="mr-2 animate-spin" />
              ) : (
                <FileSpreadsheet size={14} className="mr-2" />
              )}
              Download Excel
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={downloading !== null}
              onClick={() => onDownload("pdf")}
              data-testid="coverage-download-pdf"
            >
              {downloading === "pdf" ? (
                <Loader2 size={14} className="mr-2 animate-spin" />
              ) : (
                <FileText size={14} className="mr-2" />
              )}
              Download PDF
            </Button>
          </div>
        </div>

        {failed && rows.length === 0 ? (
          <div
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2"
            data-testid="coverage-error"
          >
            <p className="text-xs text-red-800">
              <b>Could not load the coverage numbers.</b> The employees below are not affected.
            </p>
            <Button size="sm" variant="outline" onClick={onRetry}>
              Retry
            </Button>
          </div>
        ) : loading && rows.length === 0 ? (
          <div className="space-y-2" data-testid="coverage-loading">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : (
          <Table data-testid="coverage-table">
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-32">Class</TableHead>
                {STRIP_COLUMNS.map((c) => (
                  <TableHead key={c.key} className="text-right" title={c.hint}>
                    <span className="whitespace-nowrap">{c.label}</span>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow
                  key={r.cls}
                  data-testid={`coverage-row-${r.cls}`}
                  data-selected={selected === r.cls ? "true" : undefined}
                  className={cn(selected === r.cls && "bg-slate-50")}
                >
                  <TableCell>
                    <button
                      type="button"
                      onClick={() => onSelect(r.cls)}
                      aria-pressed={selected === r.cls}
                      aria-label={`Show ${r.label} employees`}
                      className="text-left font-semibold text-gray-900 hover:underline"
                      data-testid={`coverage-select-${r.cls}`}
                    >
                      {r.label}
                      <span className="ml-1.5 text-xs font-normal text-muted-foreground">{r.counts.total} active</span>
                    </button>
                  </TableCell>
                  {STRIP_COLUMNS.map((c) => (
                    <TableCell
                      key={c.key}
                      className="text-right tabular-nums"
                      data-testid={`coverage-${r.cls}-${c.key}`}
                    >
                      {r.counts[c.key]}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {note && (
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground" data-testid="coverage-note">
            <Info size={13} className="mt-0.5 shrink-0" /> {note}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
