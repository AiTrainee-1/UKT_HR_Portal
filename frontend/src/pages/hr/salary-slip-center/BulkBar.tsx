import { ChevronDown, FileSpreadsheet, FileText, Hand, Landmark, PlayCircle, ReceiptText, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { SlipCenterEmployee, SlipFileRequest } from "@/lib/api-client/custom-hooks/salary-slip-center";
import { holdSplit, missingSlips, slipCount } from "./logic";
import { ACCENT } from "./parts";

/** What can be done with the ticked employees: generate, the three files, Hold / Release (the page keeps it in view). */
export function BulkBar({
  rows,
  hidden,
  canEdit,
  busy,
  onGenerate,
  onDownload,
  onBankFile,
  onHold,
  onRelease,
  onClear,
}: {
  /** The ticked employees. */
  rows: SlipCenterEmployee[];
  /** How many of them the current tab and filters do not show. */
  hidden: number;
  canEdit: boolean;
  busy: boolean;
  onGenerate: () => void;
  onDownload: (request: SlipFileRequest) => void;
  onBankFile: () => void;
  onHold: (rows: SlipCenterEmployee[]) => void;
  onRelease: (rows: SlipCenterEmployee[]) => void;
  onClear: () => void;
}) {
  const n = rows.length;
  const { toHold, toRelease } = holdSplit(rows);
  const missing = missingSlips(rows).length;
  // a download needs saved slips: an editor's download generates the missing ones first
  const firstNote = missing > 0 ? (canEdit ? ` (${missing} generated first)` : ` (${missing} not generated yet)`) : "";
  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-2xl border border-indigo-200 bg-indigo-50/95 px-3 py-2.5 shadow-sm backdrop-blur"
      data-testid="ssc-bulk-bar"
    >
      <p className="text-sm font-semibold text-indigo-950" data-testid="ssc-selected-count">
        {n} selected
        {hidden > 0 && <span className="ml-1 font-normal text-indigo-700">({hidden} not shown by the filters)</span>}
      </p>
      <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
        {canEdit && (
          <Button
            size="sm"
            className="gap-1.5 border-0 text-white"
            style={{ background: ACCENT }}
            disabled={busy}
            onClick={onGenerate}
            data-testid="ssc-bulk-generate"
          >
            <Wand2 size={14} /> Generate {slipCount(n)}
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 bg-white"
              disabled={busy}
              data-testid="ssc-bulk-slips"
            >
              <ReceiptText size={14} /> Download slips <ChevronDown size={13} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuLabel className="text-xs font-normal text-gray-500">
              {slipCount(n)} as one PDF{firstNote}
            </DropdownMenuLabel>
            <DropdownMenuItem
              onSelect={() => onDownload({ kind: "slips", layout: "single" })}
              data-testid="ssc-bulk-slips-single"
            >
              <FileText size={14} /> One slip per page (A4)
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => onDownload({ kind: "slips", layout: "double" })}
              data-testid="ssc-bulk-slips-double"
            >
              <FileText size={14} /> Two slips per page (landscape A4)
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 bg-white"
              disabled={busy}
              data-testid="ssc-bulk-statement"
            >
              <FileSpreadsheet size={14} /> Salary statement <ChevronDown size={13} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuLabel className="text-xs font-normal text-gray-500">
              Staff and production sections, by department{firstNote}
            </DropdownMenuLabel>
            <DropdownMenuItem
              onSelect={() => onDownload({ kind: "statement", fmt: "pdf" })}
              data-testid="ssc-bulk-statement-pdf"
            >
              <FileText size={14} /> Salary statement (PDF)
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => onDownload({ kind: "statement", fmt: "xlsx" })}
              data-testid="ssc-bulk-statement-xlsx"
            >
              <FileSpreadsheet size={14} /> Salary statement (Excel)
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5 bg-white"
          disabled={busy}
          onClick={onBankFile}
          title="Checks who can be paid by bank transfer first, then downloads the Excel bank file"
          data-testid="ssc-bulk-bank"
        >
          <Landmark size={14} /> Bank file
        </Button>
        {canEdit && toHold.length > 0 && (
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 bg-white text-orange-700"
            disabled={busy}
            onClick={() => onHold(toHold)}
            data-testid="ssc-bulk-hold"
          >
            <Hand size={14} /> Hold {toHold.length}
          </Button>
        )}
        {canEdit && toRelease.length > 0 && (
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 bg-white text-emerald-700"
            disabled={busy}
            onClick={() => onRelease(toRelease)}
            data-testid="ssc-bulk-release"
          >
            <PlayCircle size={14} /> Release {toRelease.length}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onClear} disabled={busy} data-testid="ssc-bulk-clear">
          Clear selection
        </Button>
      </div>
    </div>
  );
}
