import { useRef, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import {
  MISSED_GENERATE_MAX_IDS,
  changeMissedPayrollStatus,
  downloadMissedPayrollFile,
  fetchMissedPayrollBankCheck,
  generateMissedPayroll,
  useRefreshMissedPayroll,
  type MissedBankCheck,
  type MissedFileRequest,
  type MissedGenerateResult,
  type MissedKind,
  type MissedRefusal,
  type MissedRow,
  type MissedStatusAction,
} from "@/lib/api-client/custom-hooks/missed-payroll";
import { chunk } from "../salary-slip-center/logic";
import {
  EMPTY_GENERATE,
  employeeCount,
  eligible,
  errorText,
  fallbackFileName,
  fileLabel,
  generateWording,
  mergeGenerate,
  reportTitle,
  statusWording,
  withEntries,
  type ResultReport,
} from "./logic";

/** What the progress panel shows. `total` 0 = a single step with no count (a file being made, the bank check). */
export type JobProgress = { title: string; done: number; total: number };

/** The bank check, waiting for the reader to confirm the download. */
export type BankReview = { check: MissedBankCheck };

/** Employees per call: the server's Generate limit, and the same for the status changes so progress moves steadily. */
export const BATCH = MISSED_GENERATE_MAX_IDS;

const PROGRESS_TITLE: Record<MissedStatusAction, string> = {
  clear: "Clearing",
  unclear: "Putting back to Generated",
  discard: "Removing the generated figures of",
  done: "Adding to the payroll (Done)",
  paid: "Marking paid",
};

type Context = {
  kind: MissedKind;
  month: number;
  year: number;
  /** "November 2026". */
  period: string;
};

/**
 * Every long action of the page, one at a time: Generate in batches of 20 with progress, the status changes (also in
 * batches, stopping at the first batch the server refuses outright, e.g. a payroll run in progress), the files, and the
 * bank check before the bank file. After each action the server's refusals stay on the page until closed.
 */
export function useMissedJobs(ctx: Context) {
  const { toast } = useToast();
  const refresh = useRefreshMissedPayroll();
  const [progress, setProgress] = useState<JobProgress | null>(null);
  const [report, setReport] = useState<ResultReport | null>(null);
  const [bank, setBank] = useState<BankReview | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const { kind, month, year, period } = ctx;

  /** Runs one job; a second press while one runs does nothing. Resolves with the job's own answer. */
  const guard = async <T>(job: () => Promise<T>, fallback: T): Promise<T> => {
    if (running.current) return fallback;
    running.current = true;
    setBusy(true);
    try {
      return await job();
    } finally {
      running.current = false;
      setBusy(false);
      setProgress(null);
    }
  };

  const showReport = (title: string, items: MissedRefusal[], failed: string | null, notRun: number) =>
    setReport(items.length > 0 || failed ? { title, items, failed, notRun } : null);

  /** Generate (and save) the rows that may be generated, in batches of 20; true when anyone was generated. */
  const generate = (rows: readonly MissedRow[]) =>
    guard(async () => {
      const ids = eligible(rows, "generate").map((r) => r.id);
      if (ids.length === 0) return false;
      setReport(null);
      const title = `Generating ${employeeCount(ids.length)} for ${period}`;
      let result: MissedGenerateResult = EMPTY_GENERATE;
      let failed: string | null = null;
      let done = 0;
      setProgress({ title, done: 0, total: ids.length });
      for (const batch of chunk(ids, BATCH)) {
        try {
          result = mergeGenerate(result, await generateMissedPayroll({ kind, month, year, employeeIds: batch }));
        } catch (e) {
          failed = errorText(e);
          break;
        }
        done += batch.length;
        setProgress({ title, done, total: ids.length });
      }
      await refresh();
      const notRun = Math.max(0, ids.length - result.generated.length - result.skipped.length);
      showReport(reportTitle("generate", result.skipped.length), result.skipped, failed, notRun);
      toast(generateWording(result, ids.length, period, failed));
      return result.generated.length > 0;
    }, false);

  /** Clear / Undo clear / Remove / Done / Paid for the rows in the right status; true when anyone changed. */
  const change = (action: MissedStatusAction, rows: readonly MissedRow[], paidOn?: string) =>
    guard(async () => {
      const ids = eligible(rows, action).map((r) => r.id);
      if (ids.length === 0) return false;
      setReport(null);
      const title = `${PROGRESS_TITLE[action]} ${employeeCount(ids.length)}`;
      let changed = 0;
      let notified = 0;
      let refused: MissedRefusal[] = [];
      let failed: string | null = null;
      let done = 0;
      setProgress({ title, done: 0, total: ids.length });
      for (const batch of chunk(ids, BATCH)) {
        try {
          const r = await changeMissedPayrollStatus(action, {
            kind,
            month,
            year,
            employeeIds: batch,
            ...(action === "paid" && paidOn ? { paidOn } : {}),
          });
          changed += r.done.length;
          refused = [...refused, ...r.refused];
          notified += r.notified ?? 0;
        } catch (e) {
          failed = errorText(e);
          break;
        }
        done += batch.length;
        setProgress({ title, done, total: ids.length });
      }
      await refresh();
      const notRun = Math.max(0, ids.length - changed - refused.length);
      showReport(reportTitle(action, refused.length + notRun), refused, failed, notRun);
      toast(statusWording(action, changed, refused.length, period, failed, notified));
      return changed > 0;
    }, false);

  /** The ids a file is made of: the rows with an entry (the server ignores the others); null = nothing to download. */
  const fileIds = (rows: readonly MissedRow[]): number[] | null => {
    const ids = withEntries(rows).map((r) => r.id);
    if (ids.length === 0) {
      toast({
        title: "Nothing generated yet",
        description: `None of these employees has figures for ${period} on this page. Generate them first.`,
        variant: "destructive",
      });
      return null;
    }
    return ids;
  };

  const fetchFile = async (ids: number[], request: MissedFileRequest): Promise<boolean> => {
    setProgress({ title: fileLabel(request, ids.length), done: 0, total: 0 });
    try {
      const name = await downloadMissedPayrollFile({
        kind,
        month,
        year,
        ids,
        request,
        fallbackName: fallbackFileName(request, kind, month, year),
      });
      toast({ title: "Downloaded", description: name });
      return true;
    } catch (e) {
      toast({ title: "Could not download the file", description: errorText(e), variant: "destructive" });
      return false;
    }
  };

  /** The payroll report or the salary statement of the rows with an entry. */
  const download = (rows: readonly MissedRow[], request: MissedFileRequest) =>
    guard(async () => {
      const ids = fileIds(rows);
      if (ids) await fetchFile(ids, request);
    }, undefined);

  /** The bank check first: the page shows who the file pays, the total and who it leaves out (and why). */
  const startBankFile = (rows: readonly MissedRow[]) =>
    guard(async () => {
      setBank(null);
      const ids = fileIds(rows);
      if (!ids) return;
      setProgress({ title: `Checking who the bank file pays (${employeeCount(ids.length)})`, done: 0, total: 0 });
      try {
        setBank({ check: await fetchMissedPayrollBankCheck(kind, month, year, ids) });
      } catch (e) {
        toast({ title: "Could not check the bank file", description: errorText(e), variant: "destructive" });
      }
    }, undefined);

  /** Downloads the bank file of the employees the check let in. */
  const confirmBankFile = () =>
    guard(async () => {
      if (!bank) return;
      const ids = bank.check.included.map((i) => i.employeeId);
      if (ids.length === 0) return;
      if (await fetchFile(ids, { kind: "bank-file" })) setBank(null);
    }, undefined);

  return {
    busy,
    progress,
    report,
    closeReport: () => setReport(null),
    bank,
    closeBank: () => setBank(null),
    generate,
    change,
    download,
    startBankFile,
    confirmBankFile,
  };
}

export type MissedJobs = ReturnType<typeof useMissedJobs>;
