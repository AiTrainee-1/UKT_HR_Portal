import { useRef, useState } from "react";
import { CheckCircle2, FileSpreadsheet, Loader2, RotateCcw, ShieldCheck, UploadCloud, X, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { uploadEmployeeUpdates, uploadNewEmployees } from "./api";
import { CATEGORIES, STATUS_LABEL } from "./config";
import { decisionOverrides, formatFileSize, removalSummary } from "./logic";
import RemovalPanel from "./RemovalPanel";
import ResultsPanel from "./ResultsPanel";
import {
  InvalidTemplateError,
  type BulkResult,
  type Category,
  type ListStatus,
  type RemovalAction,
  type UploadContext,
} from "./types";

type Props = {
  kind: "create" | "update";
  category: Category;
  status: ListStatus;
  /** Called once an upload has been applied, so the employee lists refresh. */
  onApplied: () => void;
  onViewEmployees: () => void;
  /** Nothing to update yet. */
  disabled?: boolean;
};

type Phase = "idle" | "checking" | "checked" | "applying" | "done";

/**
 * Upload -> check -> apply. The file is checked first (nothing is saved), the result is shown row by row, and only then
 * does the person apply it. Updating existing employees also asks what to do with anyone missing from the file.
 */
export default function UploadFlow({ kind, category, status, onApplied, onViewEmployees, disabled }: Props) {
  const { toast } = useToast();
  const cfg = CATEGORIES[category];
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [check, setCheck] = useState<BulkResult | null>(null);
  const [done, setDone] = useState<BulkResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [fallback, setFallback] = useState<RemovalAction>("keep");
  const [overrides, setOverrides] = useState<Record<string, RemovalAction>>({});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [typed, setTyped] = useState("");

  const context: UploadContext | null = file ? { kind, category, status, fileName: file.name } : null;
  const missing = check?.missing ?? [];
  const summary = removalSummary(missing, fallback, overrides);

  const reset = () => {
    setFile(null);
    setPhase("idle");
    setCheck(null);
    setDone(null);
    setError(null);
    setFallback("keep");
    setOverrides({});
    setTyped("");
    if (inputRef.current) inputRef.current.value = "";
  };

  const call = (f: File, mode: "preview" | "apply", confirmDelete = false) =>
    kind === "create"
      ? uploadNewEmployees(f, { category, mode })
      : uploadEmployeeUpdates(f, {
          category,
          status,
          mode,
          missingAction: fallback,
          missingDecisions: decisionOverrides(missing, fallback, overrides),
          confirmDelete,
        });

  const runCheck = async (f: File) => {
    reset();
    setFile(f);
    setPhase("checking");
    try {
      const result = await call(f, "preview");
      setCheck(result);
      setPhase("checked");
    } catch (err) {
      setError(err instanceof Error ? err.message : "The file could not be checked");
      setFile(null);
      setPhase("idle");
    }
  };

  const apply = async (confirmed: boolean) => {
    if (!file) return;
    if (summary.delete > 0 && !confirmed) {
      setTyped("");
      setConfirmOpen(true);
      return;
    }
    setConfirmOpen(false);
    setPhase("applying");
    try {
      const result = await call(file, "apply", summary.delete > 0);
      setDone(result);
      setPhase("done");
      onApplied();
      toast({ title: result.message });
    } catch (err) {
      setPhase("checked");
      toast({
        title: "The upload failed",
        description: err instanceof InvalidTemplateError ? err.message : err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    }
  };

  const canApply =
    !!check &&
    (kind === "create"
      ? check.counts.created > 0
      : check.counts.updated > 0 || summary.inactive > 0 || summary.delete > 0);
  const applyLabel =
    kind === "create"
      ? `Import ${check?.counts.created ?? 0} employee${check?.counts.created === 1 ? "" : "s"}`
      : `Apply ${check?.counts.updated ?? 0} update${check?.counts.updated === 1 ? "" : "s"}${
          summary.inactive + summary.delete > 0 ? ` and remove ${summary.inactive + summary.delete}` : ""
        }`;

  const picker = (
    <input
      ref={inputRef}
      type="file"
      accept=".xlsx,.xls"
      className="hidden"
      data-testid={`bulk-file-${kind}`}
      onChange={(e) => {
        const f = e.target.files?.[0];
        if (f) void runCheck(f);
      }}
    />
  );

  return (
    <div className="space-y-4" data-testid={`upload-${kind}`}>
      {picker}

      {error && (
        <div
          className="flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 p-3"
          role="alert"
          data-testid="bulk-error"
        >
          <XCircle size={16} className="mt-0.5 shrink-0 text-red-600" />
          <p className="text-sm font-medium text-red-700">{error}</p>
        </div>
      )}

      {phase === "idle" && (
        <label
          htmlFor="bulk-drop"
          onDragOver={(e) => {
            e.preventDefault();
            if (!disabled) setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            const f = e.dataTransfer.files?.[0];
            if (f && !disabled) void runCheck(f);
          }}
          className={cn(
            "flex cursor-pointer flex-col items-center gap-2 rounded-2xl border-2 border-dashed px-5 py-9 text-center transition-colors",
            disabled && "cursor-not-allowed opacity-50",
            drag
              ? `${cfg.accent.border} ${cfg.accent.soft}`
              : "border-gray-200 bg-gray-50/60 hover:border-gray-300 hover:bg-gray-50",
          )}
        >
          <button
            id="bulk-drop"
            type="button"
            className="sr-only"
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
          >
            Choose a file
          </button>
          <div className={cn("flex h-12 w-12 items-center justify-center rounded-full", cfg.accent.soft)}>
            <UploadCloud size={22} className={cfg.accent.text} />
          </div>
          <p className="text-sm font-semibold text-gray-800">
            {drag ? "Drop the file here" : "Drag the Excel file here, or click to choose it"}
          </p>
          <p className="max-w-sm text-xs text-gray-500">
            {kind === "create"
              ? `The ${cfg.label} template, filled in. `
              : `The ${cfg.label} ${STATUS_LABEL[status].toLowerCase()} employees file you downloaded, edited. `}
            We check it first: nothing is saved until you confirm.
          </p>
          <span
            className="mt-1 inline-flex h-9 items-center rounded-lg border bg-white px-4 text-xs font-bold text-gray-700 shadow-sm"
            onClick={(e) => {
              e.preventDefault();
              if (!disabled) inputRef.current?.click();
            }}
          >
            Choose file
          </span>
        </label>
      )}

      {file && phase !== "idle" && (
        <div className={cn("flex items-center gap-3 rounded-xl border p-3", cfg.accent.border, cfg.accent.soft)}>
          <div
            className={cn(
              "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-white",
              phase === "done" ? "bg-green-600" : "bg-gray-800",
            )}
          >
            {phase === "checking" || phase === "applying" ? (
              <Loader2 size={18} className="animate-spin" />
            ) : phase === "done" ? (
              <CheckCircle2 size={18} />
            ) : (
              <FileSpreadsheet size={18} />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-gray-900">{file.name}</p>
            <p className="text-xs text-gray-600">
              {formatFileSize(file.size)} ·{" "}
              {phase === "checking"
                ? "Checking every row…"
                : phase === "applying"
                  ? "Saving…"
                  : phase === "done"
                    ? "Done"
                    : "Checked: nothing has been saved yet"}
            </p>
          </div>
          {(phase === "checked" || phase === "done") && (
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 gap-1.5 bg-white"
              onClick={reset}
              data-testid="bulk-reset"
            >
              {phase === "done" ? <RotateCcw size={13} /> : <X size={13} />}
              {phase === "done" ? "Upload another" : "Choose another"}
            </Button>
          )}
        </div>
      )}

      {phase === "checked" && check && context && (
        <>
          <ResultsPanel result={check} context={context} />

          {kind === "update" && missing.length > 0 && (
            <RemovalPanel
              missing={missing}
              total={check.scope?.total ?? 0}
              inFile={check.scope?.inFile ?? null}
              status={status}
              kindLabel={`${cfg.label} ${STATUS_LABEL[status].toLowerCase()}`}
              fallback={fallback}
              overrides={overrides}
              onFallback={(a) => {
                setFallback(a);
                setOverrides({});
              }}
              onOverride={(code, a) => setOverrides((o) => ({ ...o, [code]: a }))}
              onResetOverrides={() => setOverrides({})}
            />
          )}

          <div className="sticky bottom-3 z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-white/95 p-3 shadow-lg backdrop-blur">
            <p className="flex items-center gap-1.5 text-xs text-gray-600">
              <ShieldCheck size={14} className="text-green-600" />{" "}
              {canApply ? "Review the result above, then apply it." : "There is nothing to apply from this file."}
            </p>
            <Button
              className={cn("gap-2 text-white", cfg.accent.solid)}
              disabled={!canApply}
              onClick={() => void apply(false)}
              data-testid="bulk-apply"
            >
              <UploadCloud size={15} /> {applyLabel}
            </Button>
          </div>
        </>
      )}

      {phase === "done" && done && context && (
        <>
          <ResultsPanel result={done} context={context} />
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" className="gap-2" onClick={onViewEmployees}>
              <CheckCircle2 size={14} /> View employees
            </Button>
          </div>
        </>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {summary.delete} employee{summary.delete === 1 ? "" : "s"} for good?
            </AlertDialogTitle>
            <AlertDialogDescription>
              They will be removed together with {summary.deleteData.attendance} attendance,{" "}
              {summary.deleteData.payroll} payroll and {summary.deleteData.leaves} leave records. This cannot be undone.
              If you only want them out of the active list, go back and choose Make Inactive instead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="px-1 pb-1">
            <p className="mb-1 text-xs font-semibold text-gray-600">
              Type <span className="font-mono font-black text-red-700">DELETE</span> to confirm
            </p>
            <Input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="DELETE"
              data-testid="delete-confirm-input"
              autoComplete="off"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Go back</AlertDialogCancel>
            <AlertDialogAction
              disabled={typed.trim() !== "DELETE"}
              onClick={() => void apply(true)}
              className="bg-red-600 hover:bg-red-700"
              data-testid="delete-confirm"
            >
              Delete {summary.delete} employee{summary.delete === 1 ? "" : "s"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
