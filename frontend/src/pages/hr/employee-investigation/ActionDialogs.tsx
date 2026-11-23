import { useId, useRef, useState } from "react";
import { Loader2, Play, Power, ShieldCheck, UserCheck, UserX, type LucideIcon } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import type { InvestigationKind, InvestigationRow } from "@/lib/api-client/custom-hooks/employee-investigation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  DECISION_LABEL,
  KIND_LABEL,
  REASON_MAX,
  REASON_MIN,
  cleanReason,
  dayCount,
  employeeCount,
  names,
  reasonProblem,
  type DecisionKind,
} from "./logic";

/** What a decision dialog is about: the employees and the decision. */
export type DecisionTarget = { kind: DecisionKind; rows: { id: number; name: string; code: string }[] };

const META: Record<
  DecisionKind,
  { icon: LucideIcon; iconClass: string; button: string; title: (n: string) => string; placeholder: string }
> = {
  inactivate: {
    icon: UserX,
    iconClass: "text-red-600",
    button: "bg-red-600 text-white hover:bg-red-700",
    title: (n) => `Mark ${n} inactive?`,
    placeholder: "Why are they marked inactive? (for example: left without notice, not reachable by phone)",
  },
  keep: {
    icon: ShieldCheck,
    iconClass: "text-emerald-600",
    button: "bg-emerald-600 text-white hover:bg-emerald-700",
    title: (n) => `Keep ${n} active?`,
    placeholder: "Why are they kept active? (for example: on medical leave, papers on the way)",
  },
  reactivate: {
    icon: UserCheck,
    iconClass: "text-emerald-600",
    button: "bg-emerald-600 text-white hover:bg-emerald-700",
    title: (n) => `Make ${n} active again?`,
    placeholder: "Why are they made active again? (for example: came back with a medical note)",
  },
};

function Points({ kind }: { kind: DecisionKind }) {
  if (kind === "inactivate") {
    return (
      <ul className="list-disc space-y-1 pl-5 text-xs" data-testid="inv-decision-points">
        <li>
          It is the same as the Active / Inactive switch on the Employees page: only the status changes, nothing else
          about the employee.
        </li>
        <li>They move to the Inactive list on the Employees page.</li>
        <li>
          To undo it, make them active again from the Inactive list on the Employees page. Only the employees the Auto
          Trigger marked inactive can be made active again from this page.
        </li>
      </ul>
    );
  }
  if (kind === "keep") {
    return (
      <ul className="list-disc space-y-1 pl-5 text-xs" data-testid="inv-decision-points">
        <li>The Auto Trigger leaves them alone for this absence: it will not mark them inactive.</li>
        <li>
          They stay on this page while they are away. Once they attend again the absence ends, and a later absence
          starts fresh.
        </li>
      </ul>
    );
  }
  return (
    <ul className="list-disc space-y-1 pl-5 text-xs" data-testid="inv-decision-points">
      <li>Their status goes back to Active.</li>
      <li>
        It also keeps them active for the absence that is still running, so the next night&apos;s run does not mark them
        inactive again. Once they attend again, a later absence starts fresh.
      </li>
    </ul>
  );
}

/**
 * Mark inactive (red), Keep active or Make active again, with a required reason (3 to 500 characters) kept with the
 * decision. Nothing is sent without it. While saving the dialog stays open, and the server's error is shown inside it.
 */
export function DecisionDialog({
  target,
  pending,
  error,
  onConfirm,
  onClose,
}: {
  /** null = closed. */
  target: DecisionTarget | null;
  pending: boolean;
  /** The server's error for the last try (a missing reason, no rights ...). */
  error: string | null;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}) {
  const open = target !== null && target.rows.length > 0;
  return (
    <Dialog open={open} onOpenChange={(next) => !next && !pending && onClose()}>
      <DialogContent className="max-w-lg" data-testid="inv-decision-dialog">
        {target && (
          <DecisionBody
            key={`${target.kind}-${target.rows.map((r) => r.id).join(",")}`}
            target={target}
            pending={pending}
            error={error}
            onConfirm={onConfirm}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function DecisionBody({
  target,
  pending,
  error,
  onConfirm,
  onClose,
}: {
  target: DecisionTarget;
  pending: boolean;
  error: string | null;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const [tried, setTried] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const meta = META[target.kind];
  const Icon = meta.icon;
  const count = employeeCount(target.rows.length);
  const who = target.rows.length === 1 ? target.rows[0].name : count;
  const problem = reasonProblem(reason);
  const showProblem = tried && problem !== null;
  const length = cleanReason(reason).length;

  const submit = () => {
    setTried(true);
    if (problem) {
      box.current?.focus();
      return;
    }
    onConfirm(cleanReason(reason));
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2" data-testid="inv-decision-title">
          <Icon size={18} className={meta.iconClass} /> {meta.title(who)}
        </DialogTitle>
        <DialogDescription asChild>
          <div className="space-y-2 text-sm text-muted-foreground">
            {target.rows.length > 1 && <p data-testid="inv-decision-names">{names(target.rows)}</p>}
            <Points kind={target.kind} />
          </div>
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-1.5">
        <label htmlFor={id} className="text-sm font-semibold text-gray-800">
          Reason <span className="font-normal text-red-600">(required)</span>
        </label>
        <Textarea
          id={id}
          ref={box}
          value={reason}
          maxLength={REASON_MAX}
          onChange={(e) => setReason(e.target.value)}
          placeholder={meta.placeholder}
          rows={3}
          aria-invalid={showProblem || undefined}
          aria-describedby={`${id}-help`}
          className={cn(showProblem && "border-red-400 focus-visible:ring-red-300")}
          data-testid="inv-decision-reason"
        />
        <div id={`${id}-help`} className="flex items-start justify-between gap-3 text-xs">
          <span
            className={showProblem ? "text-red-600" : "text-muted-foreground"}
            role={showProblem ? "alert" : undefined}
            data-testid="inv-decision-help"
          >
            {showProblem ? problem : `${REASON_MIN} to ${REASON_MAX} characters, kept with the decision.`}
          </span>
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {length}/{REASON_MAX}
          </span>
        </div>
        {error && (
          <p
            className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700"
            role="alert"
            data-testid="inv-decision-error"
          >
            {error}
          </p>
        )}
      </div>
      <DialogFooter className="gap-2 sm:gap-2">
        <Button variant="outline" onClick={onClose} disabled={pending}>
          Cancel
        </Button>
        <Button
          className={cn("gap-1.5", meta.button)}
          onClick={submit}
          disabled={pending}
          data-testid="inv-decision-confirm"
        >
          {pending ? <Loader2 size={14} className="animate-spin" /> : <Icon size={14} />}
          {DECISION_LABEL[target.kind]}
          {target.rows.length > 1 ? ` (${target.rows.length})` : ""}
        </Button>
      </DialogFooter>
    </>
  );
}

/** Confirms switching the Auto Trigger on or off (one company-wide switch). */
export function AutoSwitchDialog({
  next,
  tonight,
  autoDays,
  runAt,
  pending,
  error,
  onConfirm,
  onClose,
}: {
  /** The value it would switch to; null = closed. */
  next: boolean | null;
  /** How many the next run would mark inactive (in this login's scope). */
  tonight: number;
  autoDays: number;
  runAt: string;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const on = next === true;
  return (
    <Dialog open={next !== null} onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent className="max-w-md" data-testid="inv-switch-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Power size={18} className={on ? "text-emerald-600" : "text-gray-600"} />
            {on ? "Switch the Auto Trigger on?" : "Switch the Auto Trigger off?"}
          </DialogTitle>
          <DialogDescription data-testid="inv-switch-text">
            {on
              ? `From tonight at ${runAt} it marks inactive every employee away more than ${autoDays} days in a row who is not on approved leave, not kept active and has attendance on record. ${
                  tonight > 0
                    ? `${employeeCount(tonight)} would be marked inactive at the next run.`
                    : "Nobody would be marked inactive at the next run."
                }`
              : "Nobody is marked inactive automatically until it is switched on again. The 15 Days and 30 Days lists, Keep active and Mark inactive keep working."}{" "}
            It is one switch for the whole company.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p
            className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700"
            role="alert"
            data-testid="inv-switch-error"
          >
            {error}
          </p>
        )}
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            className={cn("gap-1.5", on ? "bg-emerald-600 text-white hover:bg-emerald-700" : "")}
            variant={on ? "default" : "destructive"}
            onClick={onConfirm}
            disabled={pending}
            data-testid="inv-switch-confirm"
          >
            {pending ? <Loader2 size={14} className="animate-spin" /> : <Power size={14} />}
            {on ? "Switch on" : "Switch off"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Run now: the Auto Trigger at once, by exactly tonight's rules, even while it is switched off. Lists everyone it would
 * mark inactive (the whole company's Tonight list); each one can be made active again from the History.
 */
export function RunNowDialog({
  open,
  rows,
  kind,
  autoEnabled,
  runAt,
  pending,
  error,
  onConfirm,
  onClose,
}: {
  open: boolean;
  /** Everyone the run would mark inactive (all kinds); null while it is being read. */
  rows: InvestigationRow[] | null;
  /** The tab's kind filter: when it is not All, the dialog says the run is for everyone. */
  kind: InvestigationKind;
  autoEnabled: boolean;
  runAt: string;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const n = rows?.length ?? 0;
  return (
    <Dialog open={open} onOpenChange={(next) => !next && !pending && onClose()}>
      <DialogContent className="max-w-lg" data-testid="inv-run-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2" data-testid="inv-run-title">
            <Play size={18} className="text-red-600" />
            {rows === null ? "Run the Auto Trigger now?" : `Mark ${employeeCount(n)} inactive now?`}
          </DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground" data-testid="inv-run-text">
              <p>
                It is the same as tonight&apos;s {runAt} run, done now
                {autoEnabled ? "" : ", even though the Auto Trigger is switched off"}: everyone below is marked inactive
                by its rules. Each one can be made active again from the History on this tab.
              </p>
              {kind !== "all" && (
                <p className="font-semibold text-gray-800" data-testid="inv-run-scope">
                  It runs for the whole company: staff and production alike, not only the{" "}
                  {KIND_LABEL[kind].toLowerCase()} employees this tab is showing.
                </p>
              )}
            </div>
          </DialogDescription>
        </DialogHeader>
        {rows === null ? (
          <div className="space-y-2" aria-busy="true" data-testid="inv-run-loading">
            <Skeleton className="h-8 w-full rounded-lg" />
            <Skeleton className="h-8 w-full rounded-lg" />
          </div>
        ) : (
          <ul className="max-h-64 divide-y overflow-y-auto rounded-xl border text-sm" data-testid="inv-run-list">
            {rows.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 px-3 py-2" data-testid="inv-run-item">
                <span className="min-w-0">
                  <span className="font-semibold text-gray-900">{r.name}</span>{" "}
                  <span className="font-mono text-xs text-gray-500">{r.code}</span>
                </span>{" "}
                <span className="shrink-0 text-xs font-semibold tabular-nums text-gray-700">
                  {dayCount(r.absentDays)} away
                </span>
              </li>
            ))}
          </ul>
        )}
        {error && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700" role="alert" data-testid="inv-run-error">
            {error}
          </p>
        )}
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            className="gap-1.5"
            onClick={onConfirm}
            disabled={pending || rows === null || n === 0}
            data-testid="inv-run-confirm"
          >
            {pending ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            Run now: mark {employeeCount(n)} inactive
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
