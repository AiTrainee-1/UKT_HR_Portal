import {
  BadgeCheck,
  ChevronDown,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  FileText,
  Landmark,
  Trash2,
  Undo2,
  Wallet,
  Wand2,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { MissedFileRequest, MissedRow } from "@/lib/api-client/custom-hooks/missed-payroll";
import { cn } from "@/lib/utils";
import { ACCENT } from "../salary-slip-center/parts";
import {
  ACTION_LABEL,
  actionBlock,
  actionSplit,
  employeeCount,
  withEntries,
  type MissedAction,
  type Rights,
} from "./logic";

/** The three files of the rows with an entry: the payroll report, the salary statement, the bank file (checked first). */
export function ExportMenu({
  rows,
  busy,
  label,
  scope,
  onDownload,
  onBankFile,
  testId,
}: {
  rows: readonly MissedRow[];
  busy: boolean;
  label: string;
  /** "selected" / "listed": what the menu says it is made of. */
  scope: string;
  onDownload: (request: MissedFileRequest) => void;
  onBankFile: () => void;
  testId: string;
}) {
  const ready = withEntries(rows).length;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline" className="gap-1.5 bg-white" disabled={busy} data-testid={testId}>
          <Download size={14} /> {label} <ChevronDown size={13} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="text-xs font-normal text-gray-500">
          {ready > 0
            ? `${employeeCount(ready)} ${scope} with figures on this page`
            : `None of the ${scope} employees has figures yet: generate them first`}
        </DropdownMenuLabel>
        <DropdownMenuItem
          disabled={ready === 0}
          onSelect={() => onDownload({ kind: "report" })}
          data-testid={`${testId}-report`}
        >
          <FileSpreadsheet size={14} /> Payroll report (Excel)
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={ready === 0}
          onSelect={() => onDownload({ kind: "statement", fmt: "pdf" })}
          data-testid={`${testId}-statement-pdf`}
        >
          <FileText size={14} /> Salary statement (PDF)
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={ready === 0}
          onSelect={() => onDownload({ kind: "statement", fmt: "xlsx" })}
          data-testid={`${testId}-statement-xlsx`}
        >
          <FileSpreadsheet size={14} /> Salary statement (Excel)
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={ready === 0} onSelect={onBankFile} data-testid={`${testId}-bank`}>
          <Landmark size={14} /> Bank file (checks who it pays first)
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const ACTION_ICON: Record<MissedAction, LucideIcon> = {
  generate: Wand2,
  clear: CheckCircle2,
  unclear: Undo2,
  discard: Trash2,
  done: BadgeCheck,
  paid: Wallet,
};

const ACTION_CLASS: Partial<Record<MissedAction, string>> = {
  discard: "text-red-700",
  done: "text-emerald-700",
  paid: "text-emerald-700",
};

/** One action of the bar: its count, or why it cannot run (rights first, then the selection), as the hover text. */
function ActionButton({
  action,
  rows,
  rights,
  busy,
  onRun,
}: {
  action: MissedAction;
  rows: readonly MissedRow[];
  rights: Rights;
  busy: boolean;
  onRun: () => void;
}) {
  const block = actionBlock(action, rows, rights);
  const count = actionSplit(rows)[action].length;
  const Icon = ACTION_ICON[action];
  const primary = action === "generate";
  return (
    <span title={block ?? undefined} className="inline-flex">
      <Button
        size="sm"
        variant={primary ? "default" : "outline"}
        className={cn("gap-1.5", primary ? "border-0 text-white" : cn("bg-white", ACTION_CLASS[action]))}
        style={primary && !block ? { background: ACCENT } : undefined}
        disabled={busy || block !== null}
        onClick={onRun}
        aria-label={block ? `${ACTION_LABEL[action]}: ${block}` : `${ACTION_LABEL[action]} ${employeeCount(count)}`}
        data-testid={`mp-bulk-${action}`}
      >
        <Icon size={14} /> {ACTION_LABEL[action]}
        {count > 0 && <span className="tabular-nums opacity-80">{` (${count})`}</span>}
      </Button>
    </span>
  );
}

/** What can be done with the ticked employees: Generate, the status steps, the files (the page keeps it in view). */
export function BulkBar({
  rows,
  hidden,
  rights,
  busy,
  onAction,
  onDownload,
  onBankFile,
  onClearSelection,
}: {
  /** The ticked employees, fresh from the list. */
  rows: MissedRow[];
  /** How many of them the current view and filters do not show. */
  hidden: number;
  rights: Rights;
  busy: boolean;
  onAction: (action: MissedAction) => void;
  onDownload: (request: MissedFileRequest) => void;
  onBankFile: () => void;
  onClearSelection: () => void;
}) {
  const steps: MissedAction[] = ["generate", "clear", "unclear", "discard", "done", "paid"];
  return (
    <div
      className="space-y-2 rounded-2xl border border-indigo-200 bg-indigo-50/95 px-3 py-2.5 shadow-sm backdrop-blur"
      data-testid="mp-bulk-bar"
      role="region"
      aria-label="Actions for the selected employees"
    >
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-semibold text-indigo-950" data-testid="mp-selected-count">
          {rows.length} selected
          {hidden > 0 && <span className="ml-1 font-normal text-indigo-700">({hidden} not shown by the view)</span>}
        </p>
        <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
          <ExportMenu
            rows={rows}
            busy={busy}
            label="Files"
            scope="selected"
            onDownload={onDownload}
            onBankFile={onBankFile}
            testId="mp-bulk-files"
          />
          <Button size="sm" variant="ghost" onClick={onClearSelection} disabled={busy} data-testid="mp-bulk-unselect">
            Untick all
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {steps.map((action) => (
          <ActionButton
            key={action}
            action={action}
            rows={rows}
            rights={rights}
            busy={busy}
            onRun={() => onAction(action)}
          />
        ))}
      </div>
      {!rights.wholeCompany && rights.canEdit && (
        <p className="text-[11px] text-indigo-800/80">
          Done and Paid change the month&apos;s payroll for the whole company: only a login for all units can do them.
        </p>
      )}
    </div>
  );
}
