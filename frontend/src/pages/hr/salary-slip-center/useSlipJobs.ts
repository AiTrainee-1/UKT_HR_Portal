import { useRef, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import {
  downloadSalarySlipCenterFile,
  fetchSalarySlipBankCheck,
  generateSalarySlips,
  useHoldSalarySlips,
  useRefreshSalarySlipCenter,
  type BankCheck,
  type GenerateSlipsResult,
  type SkippedSlip,
  type SlipCenterEmployee,
  type SlipFileRequest,
  type SlipOptions,
} from "@/lib/api-client/custom-hooks/salary-slip-center";
import {
  EMPTY_RESULT,
  GENERATE_BATCH,
  chunk,
  employeeCount,
  errorText,
  fallbackFileName,
  fileLabel,
  generateWording,
  idsWithSlips,
  mergeResults,
  missingFromError,
  missingSlips,
  slipCount,
} from "./logic";

/** What the progress panel shows. `total` 0 = a single step with no count (a file being made, the bank check). */
export type JobProgress = { title: string; done: number; total: number };

/** The employees a Generate run skipped (no salary ...), and whether it stopped early. Shown on the page until closed. */
export type SkipReport = { skipped: SkippedSlip[]; failed: string | null; notRun: number };

/** The bank check, waiting for the reader to confirm the download. */
export type BankReview = { check: BankCheck; rows: SlipCenterEmployee[] };

type Context = {
  month: number;
  year: number;
  /** "November 2026". */
  period: string;
  canEdit: boolean;
  options: SlipOptions;
  /** The month's whole list (a 409's missing ids are looked up here). */
  employees: readonly SlipCenterEmployee[];
};

/**
 * Every long action of the page, one at a time: Generate in batches of 20 with progress, the downloads (which generate
 * the missing slips first, and once more if the server answers 409 with `missing`), the bank check before the bank file,
 * and Hold / Release.
 */
export function useSlipJobs(ctx: Context) {
  const { toast } = useToast();
  const refresh = useRefreshSalarySlipCenter();
  const holdMutation = useHoldSalarySlips();
  const [progress, setProgress] = useState<JobProgress | null>(null);
  const [report, setReport] = useState<SkipReport | null>(null);
  const [bank, setBank] = useState<BankReview | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const { month, year, period, canEdit, options } = ctx;

  /** Runs one job; a second press while one runs does nothing. */
  const guard = async (job: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      await job();
    } finally {
      running.current = false;
      setBusy(false);
      setProgress(null);
    }
  };

  /** Generate (and save) in batches of 20, showing "x of y"; stops at the first batch the server refuses. */
  const runGenerate = async (
    rows: readonly SlipCenterEmployee[],
    title: string,
  ): Promise<{ result: GenerateSlipsResult; failed: string | null }> => {
    const ids = rows.map((r) => r.id);
    let result = EMPTY_RESULT;
    let failed: string | null = null;
    let done = 0;
    setProgress({ title, done: 0, total: ids.length });
    for (const batch of chunk(ids, GENERATE_BATCH)) {
      try {
        result = mergeResults(result, await generateSalarySlips({ month, year, employeeIds: batch, options }));
      } catch (e) {
        failed = errorText(e);
        break;
      }
      done += batch.length;
      setProgress({ title, done, total: ids.length });
    }
    await refresh();
    const notRun = Math.max(0, ids.length - result.generated.length - result.skipped.length);
    setReport(result.skipped.length > 0 || failed ? { skipped: result.skipped, failed, notRun } : null);
    return { result, failed };
  };

  const generate = (rows: readonly SlipCenterEmployee[]) =>
    guard(async () => {
      if (!canEdit || rows.length === 0) return;
      setReport(null);
      const { result, failed } = await runGenerate(rows, `Generating ${slipCount(rows.length)} for ${period}`);
      toast(generateWording(result, rows.length, period, failed));
    });

  /**
   * The ids a file may be made of. Missing slips are generated first (edit), or left out with a note (view: someone with
   * edit rights has to generate them). Null = stop (nothing to download, or the generation failed).
   */
  const prepare = async (rows: readonly SlipCenterEmployee[]): Promise<number[] | null> => {
    const missing = missingSlips(rows);
    if (missing.length === 0) return rows.map((r) => r.id);
    if (!canEdit) {
      const ready = rows.filter((r) => r.slip);
      if (ready.length === 0) {
        toast({
          title: "No saved slips to download",
          description: `None of the selected employees has a saved slip for ${period} yet. Someone with edit rights has to generate them first.`,
          variant: "destructive",
        });
        return null;
      }
      toast({
        title: `${employeeCount(missing.length)} left out`,
        description: `No saved slip for ${period} yet, so the file has the other ${employeeCount(ready.length)}.`,
      });
      return ready.map((r) => r.id);
    }
    setReport(null);
    const { result, failed } = await runGenerate(
      missing,
      `Generating ${slipCount(missing.length)} first (not generated yet)`,
    );
    if (failed) {
      toast({ title: "Stopped before the download", description: failed, variant: "destructive" });
      return null;
    }
    const ids = idsWithSlips(
      rows,
      result.generated.map((g) => g.employeeId),
    );
    if (ids.length === 0) {
      toast({
        title: "Nothing to download",
        description: "None of the selected employees could be given a slip. The skipped list on the page says why.",
        variant: "destructive",
      });
      return null;
    }
    return ids;
  };

  /** Fetches and saves one file; on a 409 (slips missing on the server) generates them once and tries again. */
  const fetchFile = async (
    ids: number[],
    rows: readonly SlipCenterEmployee[],
    request: SlipFileRequest,
    retry: boolean,
  ): Promise<boolean> => {
    const chosen = rows.filter((r) => ids.includes(r.id));
    setProgress({ title: fileLabel(request, ids.length), done: 0, total: 0 });
    try {
      const name = await downloadSalarySlipCenterFile({
        month,
        year,
        ids,
        request,
        fallbackName: fallbackFileName(request, month, year, chosen),
      });
      toast({ title: "Downloaded", description: name });
      return true;
    } catch (e) {
      const missing = missingFromError(e);
      if (missing && canEdit && retry) {
        const missingRows = ctx.employees.filter((r) => missing.includes(r.id));
        const { result, failed } = await runGenerate(
          missingRows,
          `Generating ${slipCount(missingRows.length)} first (not saved yet)`,
        );
        if (failed) {
          toast({ title: "Stopped before the download", description: failed, variant: "destructive" });
          return false;
        }
        const made = new Set(result.generated.map((g) => g.employeeId));
        const ok = ids.filter((id) => !missing.includes(id) || made.has(id));
        if (ok.length === 0) {
          toast({ title: "Nothing to download", description: errorText(e), variant: "destructive" });
          return false;
        }
        return fetchFile(ok, rows, request, false);
      }
      toast({ title: "Could not download the file", description: errorText(e), variant: "destructive" });
      return false;
    }
  };

  const download = (rows: readonly SlipCenterEmployee[], request: SlipFileRequest) =>
    guard(async () => {
      if (rows.length === 0) return;
      const ids = await prepare(rows);
      if (ids) await fetchFile(ids, rows, request, true);
    });

  /** The bank check first (after generating any missing slips): the page shows who is in, the total and who is left out. */
  const startBankFile = (rows: readonly SlipCenterEmployee[]) =>
    guard(async () => {
      if (rows.length === 0) return;
      setBank(null);
      // a view-only login cannot generate: the check itself names the missing ones ("Not generated yet")
      if (canEdit && missingSlips(rows).length > 0) {
        const ids = await prepare(rows);
        if (!ids) return;
      }
      setProgress({ title: `Checking the bank details of ${employeeCount(rows.length)}`, done: 0, total: 0 });
      try {
        const check = await fetchSalarySlipBankCheck(
          month,
          year,
          rows.map((r) => r.id),
        );
        setBank({ check, rows: [...rows] });
      } catch (e) {
        toast({ title: "Could not check the bank details", description: errorText(e), variant: "destructive" });
      }
    });

  /** Downloads the bank file of the employees the check let in (only those: the left-out ones would be refused). */
  const confirmBankFile = () =>
    guard(async () => {
      if (!bank) return;
      const ids = bank.check.included.map((i) => i.employeeId);
      if (ids.length === 0) return;
      const ok = await fetchFile(ids, bank.rows, { kind: "bank-file" }, true);
      if (ok) setBank(null);
    });

  /** Hold (with an optional reason) or Release employees for the month. Resolves true when the server took it. */
  const setHold = async (rows: readonly SlipCenterEmployee[], hold: boolean, reason = ""): Promise<boolean> => {
    if (!canEdit || rows.length === 0) return false;
    try {
      const r = await holdMutation.mutateAsync({
        month,
        year,
        employeeIds: rows.map((row) => row.id),
        hold,
        ...(hold && reason.trim() ? { reason: reason.trim() } : {}),
      });
      toast(
        hold
          ? {
              title: `${employeeCount(r.updated)} on hold for ${period}`,
              description: "They still get slips and stay on the statement (Remarks HOLD), but not in the bank file.",
            }
          : {
              title: `${employeeCount(r.updated)} released for ${period}`,
              description: "They are back in the bank file.",
            },
      );
      return true;
    } catch (e) {
      toast({
        title: hold ? "Could not put on hold" : "Could not release",
        description: errorText(e),
        variant: "destructive",
      });
      return false;
    }
  };

  return {
    busy,
    progress,
    report,
    closeReport: () => setReport(null),
    bank,
    closeBank: () => setBank(null),
    generate,
    download,
    startBankFile,
    confirmBankFile,
    setHold,
    holding: holdMutation.isPending,
  };
}
