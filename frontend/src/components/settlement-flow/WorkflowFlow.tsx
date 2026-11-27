import { useState, type CSSProperties, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Check, ChevronDown, CornerDownRight, History, Minus, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The Loan & Advance workflow as a BRANCHING tracker (owner 2026-11-27: "a branching workflow tracker rather than a
 * simple linear progress tracker"), shared by the HRMS and the MD portal.
 *
 * The normal path runs across: Received -> HR Review -> MD Review -> HR Final Settlement -> Send to Auditor -> Auditor
 * Review -> Send Bank File to Accounts -> Completed. Two REWORK LOOPS hang under the reviews: MD Review <-> HR Rework (MD
 * Changes) and Auditor Review <-> HR Rework (Auditor Changes), with how often each was gone round ("Returned 2x").
 * The MD's APPROVED PATH is drawn as a fork over HR Final Settlement: through HR, or "Direct to auditor" (solid when
 * taken, dashed when not). Done stages are ticked with when / by whom / what happened, the current one is ringed with
 * what has to happen next, skipped ones are dashed. Under it: the path taken, the rounds and the approval history.
 *
 * Wide containers draw the diagram; narrow ones (a phone, the MD's side panel) a list with the loops indented.
 */

export type FlowStepState = "done" | "current" | "pending" | "skipped";

export type FlowStep = {
  key: string;
  label: string;
  state: FlowStepState;
  at: string | null;
  by: string | null;
  detail?: string | null;
  action: string | null;
  loop?: boolean;
  cycles?: number | null;
  round?: number | null;
};

export type FlowFacts = {
  mdRound: number;
  auditorRound: number;
  mdCycles: number;
  auditorCycles: number;
  mdPath: "hr" | "direct" | null;
  accountsVia: "hr" | "auditor" | null;
  mdReturn?: { at: string; by: string | null; note: string } | null;
};

export type FlowHistoryEntry = {
  at: string;
  by: string;
  action: string;
  note?: string;
  round?: number;
  direct?: boolean;
  via?: string;
  [extra: string]: unknown;
};

type Variant = "hrms" | "md";

const MAIN = [
  "received",
  "hr_review",
  "md_review",
  "hr_final",
  "auditor_send",
  "auditor_review",
  "accounts_send",
  "completed",
] as const;
/** The loop stage -> the review (main column) it hangs under. */
const LOOPS: Record<string, string> = { md_changes: "md_review", auditor_changes: "auditor_review" };

const STATE_WORD: Record<FlowStepState, string> = {
  done: "Done",
  current: "Current step",
  pending: "Pending",
  skipped: "Skipped",
};

/** The two skins: the HRMS (emerald / indigo / amber on white glass) and the MD portal's own tokens (wine / sand). */
const SKIN = {
  hrms: {
    done: "bg-emerald-500 text-white",
    current: "bg-indigo-600 text-white ring-4 ring-indigo-100",
    pending: "border-2 border-slate-200 bg-white text-slate-400",
    skipped: "border-2 border-dashed border-slate-300 bg-slate-50 text-slate-400",
    rework: "bg-amber-500 text-white",
    reworkNow: "bg-amber-500 text-white ring-4 ring-amber-100",
    line: "bg-emerald-400",
    lineIdle: "bg-slate-200",
    edge: "border-emerald-400",
    edgeIdle: "border-slate-300",
    edgeRework: "border-amber-400",
    arrowRework: "text-amber-500",
    arrowIdle: "text-slate-300",
    ink: "text-slate-800",
    inkNow: "text-indigo-700",
    inkMuted: "text-slate-400",
    inkSoft: "text-slate-500",
    detail: "text-emerald-700",
    detailRework: "text-amber-700",
    now: "bg-indigo-50 text-indigo-700",
    reworkPill: "bg-amber-50 text-amber-800 ring-1 ring-amber-200",
    hover: "hover:bg-slate-50",
    selected: "bg-indigo-50/80 ring-1 ring-indigo-200",
    focus: "focus-visible:ring-indigo-300",
    next: "border-indigo-100 bg-indigo-50 text-indigo-900",
    chip: "border-slate-200 bg-white/80 text-slate-600",
    chipGood: "border-emerald-200 bg-emerald-50 text-emerald-800",
    chipRework: "border-amber-200 bg-amber-50 text-amber-800",
    fork: "bg-white text-slate-500 ring-1 ring-slate-200",
    forkTaken: "bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200",
    panel: "border-slate-100 bg-slate-50/60",
  },
  md: {
    done: "bg-md-success-600 text-white",
    current: "bg-md-wine text-white ring-4 ring-md-wine/15",
    pending: "border border-md-ink/15 bg-white/70 text-md-ink-soft",
    skipped: "border border-dashed border-md-ink/30 bg-white/70 text-md-ink-soft",
    rework: "bg-md-warning-500 text-white",
    reworkNow: "bg-md-warning-500 text-white ring-4 ring-md-warning-500/20",
    line: "bg-md-success-500",
    lineIdle: "bg-md-ink/10",
    edge: "border-md-success-500",
    edgeIdle: "border-md-ink/20",
    edgeRework: "border-md-warning-500",
    arrowRework: "text-md-warning-600",
    arrowIdle: "text-md-ink/25",
    ink: "text-md-ink",
    inkNow: "text-md-wine",
    inkMuted: "text-md-ink-soft",
    inkSoft: "text-md-ink-soft",
    detail: "text-md-success-700",
    detailRework: "text-md-warning-700",
    now: "bg-md-wine/10 text-md-wine",
    reworkPill: "bg-md-warning-50 text-md-warning-800 ring-1 ring-md-warning-200",
    hover: "hover:bg-white/60",
    selected: "bg-md-wine/5 ring-1 ring-md-wine/20",
    focus: "focus-visible:ring-md-wine/30",
    next: "border-md-wine/15 bg-md-wine/5 text-md-ink",
    chip: "border-md-ink/10 bg-white/70 text-md-ink-soft",
    chipGood: "border-md-success-200 bg-md-success-50 text-md-success-800",
    chipRework: "border-md-warning-200 bg-md-warning-50 text-md-warning-800",
    fork: "bg-white/80 text-md-ink-soft ring-1 ring-md-ink/10",
    forkTaken: "bg-md-success-50 text-md-success-800 ring-1 ring-md-success-200",
    panel: "border-md-ink/10 bg-white/50",
  },
} as const;

type Skin = (typeof SKIN)[Variant];

const AT = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "Asia/Kolkata",
});
const when = (iso: string | null | undefined): string => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : AT.format(d);
};
const stampOf = (step: FlowStep) => [when(step.at), step.by ?? ""].filter(Boolean).join(" · ");
const times = (n: number) => (n === 1 ? "once" : `${n}×`);

/** One history action in words, and its tone (a return amber, an approval green, a send blue). */
export function historyLabel(h: FlowHistoryEntry): { text: string; tone: "good" | "rework" | "send" | "plain" } {
  const round = typeof h.round === "number" && h.round > 1 ? ` (round ${h.round})` : "";
  switch (h.action) {
    case "forwarded":
      return { text: "HR forwarded it to the MD", tone: "send" };
    case "md_returned":
      return {
        text: `MD returned it to HR for rework${typeof h.round === "number" ? ` (round ${h.round})` : ""}`,
        tone: "rework",
      };
    case "md_resubmitted":
      return { text: `HR resubmitted it to the MD${round}`, tone: "send" };
    case "md_confirmed":
      return {
        text: h.direct ? "MD approved it and sent it directly to the auditor" : "MD approved it and sent it to HR",
        tone: "good",
      };
    case "finalized":
      return { text: h.via === "md" ? "Finalized by the MD" : "HR finalized the settlement", tone: "good" };
    case "auditor_sent":
      return { text: "Sent to the auditor", tone: "send" };
    case "auditor_resent":
      return { text: "Sent to the auditor again", tone: "send" };
    case "auditor_changes":
      return {
        text: `Auditor returned it to HR for rework${typeof h.round === "number" ? ` (round ${h.round})` : ""}`,
        tone: "rework",
      };
    case "auditor_resubmitted":
      return { text: `HR resubmitted it to the auditor${round}`, tone: "send" };
    case "auditor_changes_accepted":
      return { text: "HR accepted the auditor's changes", tone: "good" };
    case "auditor_approved":
      return { text: "Auditor approved it", tone: "good" };
    case "auditor_confirmed":
      return { text: "HR confirmed the auditor's review", tone: "good" };
    case "accounts_sent":
      return {
        text: h.via === "auditor" ? "Auditor sent the bank file to Accounts" : "HR sent the bank file to Accounts",
        tone: "send",
      };
    case "accounts_resent":
      return { text: "Bank file sent to Accounts again", tone: "send" };
    case "accounts_failed_from_auditor":
      return { text: "The auditor's e-mail to Accounts did not go", tone: "rework" };
    case "completed":
      return { text: "Workflow completed", tone: "good" };
    case "completed_no_payments":
      return { text: "Completed (nothing to pay)", tone: "good" };
    default:
      return { text: h.action.replace(/_/g, " "), tone: "plain" };
  }
}

function Dot({ step, number, skin, size = 8 }: { step: FlowStep; number?: number; skin: Skin; size?: 7 | 8 }) {
  const loop = Boolean(step.loop);
  return (
    <span
      aria-hidden
      className={cn(
        "relative z-10 flex shrink-0 items-center justify-center rounded-full text-xs font-bold transition-colors",
        size === 8 ? "h-8 w-8" : "h-7 w-7",
        loop && step.state === "current" && skin.reworkNow,
        loop && step.state === "done" && skin.rework,
        !loop && step.state === "done" && skin.done,
        !loop && step.state === "current" && skin.current,
        step.state === "pending" && skin.pending,
        step.state === "skipped" && skin.skipped,
      )}
    >
      {loop && (step.state === "done" || step.state === "current") ? (
        <RotateCcw size={14} strokeWidth={2.6} />
      ) : step.state === "done" ? (
        <Check size={15} strokeWidth={3} />
      ) : step.state === "skipped" ? (
        <Minus size={14} strokeWidth={3} />
      ) : loop ? (
        <RotateCcw size={13} strokeWidth={2.2} />
      ) : (
        number
      )}
    </span>
  );
}

type Ids = { root: string; step: (k: string) => string; open: (k: string) => string; detail: (k: string) => string };

const HRMS_IDS: Ids = {
  root: "settlement-tracker",
  step: (k) => `tracker-step-${k}`,
  open: (k) => `tracker-open-${k}`,
  detail: (k) => `tracker-detail-${k}`,
};
const MD_IDS: Ids = {
  root: "md-settlement-tracker",
  step: (k) => `md-settlement-step-${k}`,
  open: (k) => `md-settlement-open-${k}`,
  detail: (k) => `md-settlement-step-detail-${k}`,
};

export default function WorkflowFlow({
  steps,
  flow,
  history = [],
  received,
  label = "Loan & Advance workflow",
  variant = "hrms",
  onSelect,
  selected = null,
  showNext = true,
}: {
  steps: FlowStep[];
  flow?: FlowFacts | null;
  /** The batch's history (oldest first): the approval history under the diagram. */
  history?: FlowHistoryEntry[];
  /** The requests in the batch: the first stage's figure. */
  received: number;
  label?: string;
  variant?: Variant;
  /** Clickable stages (HRMS): a click lists that stage's requests under the tracker. */
  onSelect?: (key: string) => void;
  selected?: string | null;
  /** Show the "Next:" line with what has to happen at the current stage. */
  showNext?: boolean;
}) {
  const skin = SKIN[variant];
  const ids = variant === "md" ? MD_IDS : HRMS_IDS;
  const byKey = new Map(steps.map((s) => [s.key, s]));
  const current = steps.find((s) => s.state === "current");
  const [historyOpen, setHistoryOpen] = useState(false);

  const subline = (step: FlowStep) =>
    step.key === "received" && step.state === "done"
      ? `${received} ${received === 1 ? "request" : "requests"}`
      : step.state === "done"
        ? stampOf(step)
        : "";
  const ink = (step: FlowStep) =>
    step.state === "current"
      ? step.loop
        ? skin.detailRework
        : skin.inkNow
      : step.state === "done"
        ? skin.ink
        : skin.inkMuted;

  /** A stage's dot and words, a button when the stages are clickable. */
  const node = (step: FlowStep, body: ReactNode, className: string, testId: string) =>
    onSelect ? (
      <button
        type="button"
        onClick={() => onSelect(step.key)}
        aria-pressed={selected === step.key}
        title={`Show the requests of ${step.label}`}
        className={cn(
          className,
          "rounded-xl transition-colors focus-visible:outline-none focus-visible:ring-2",
          skin.hover,
          skin.focus,
          selected === step.key && skin.selected,
        )}
        data-view-safe
        data-testid={testId}
      >
        {body}
      </button>
    ) : (
      <div className={className}>{body}</div>
    );

  const words = (step: FlowStep, compact = false) => (
    <>
      <p className={cn("font-semibold leading-tight", compact ? "text-[12px]" : "text-[12px]", ink(step))}>
        <span className="sr-only">{STATE_WORD[step.state]}: </span>
        {step.label}
        {step.round && step.round > 1 && step.state !== "pending" ? (
          <span className={cn("ml-1 whitespace-nowrap text-[10.5px] font-semibold", skin.inkSoft)}>
            · round {step.round}
          </span>
        ) : null}
      </p>
      {step.detail && step.state !== "pending" && (
        <p
          className={cn(
            "mt-0.5 text-[10.5px] font-semibold leading-snug",
            step.state === "skipped" ? cn("italic", skin.inkMuted) : step.loop ? skin.detailRework : skin.detail,
          )}
          data-testid={ids.detail(step.key)}
        >
          {step.detail}
        </p>
      )}
      {subline(step) && <p className={cn("mt-0.5 text-[10.5px] leading-snug", skin.inkSoft)}>{subline(step)}</p>}
      {step.state === "current" && (
        <span
          className={cn(
            "mt-1 inline-block rounded-full px-2 py-0.5 text-[10px] font-bold",
            step.loop ? skin.reworkPill : skin.now,
          )}
        >
          {step.loop ? "Rework now" : "Now"}
        </span>
      )}
    </>
  );

  // ── the wide diagram ──
  const place = (col: number, row: number, span = 1): CSSProperties => ({
    gridColumn: `${col} / span ${span}`,
    gridRow: row,
  });
  const hrFinal = byKey.get("hr_final");
  const direct = flow?.mdPath === "direct" || hrFinal?.state === "skipped";
  const viaHr = flow?.mdPath === "hr";

  const mainNodes = MAIN.map((key, i) => {
    const step = byKey.get(key);
    if (!step) return null;
    const prev = i > 0 ? byKey.get(MAIN[i - 1]) : null;
    // the line into this stage: dashed when it is not the path taken (HR Final when the MD sent it directly)
    const bypassed = (key === "hr_final" || key === "auditor_send") && direct;
    const lineDone = step.state !== "pending" && prev?.state !== "pending";
    return (
      <li
        key={key}
        style={place(i + 1, 2)}
        className="relative flex flex-col items-center px-0.5 text-center"
        aria-current={step.state === "current" ? "step" : undefined}
        data-testid={ids.step(key)}
        data-state={step.state}
      >
        {i > 0 &&
          (bypassed ? (
            <span
              aria-hidden
              className={cn("absolute right-1/2 top-4 w-full -translate-y-1/2 border-t-2 border-dashed", skin.edgeIdle)}
            />
          ) : (
            <span
              aria-hidden
              className={cn(
                "absolute right-1/2 top-4 h-0.5 w-full -translate-y-1/2",
                lineDone ? skin.line : skin.lineIdle,
              )}
            />
          ))}
        {node(
          step,
          <>
            <Dot step={step} number={i + 1} skin={skin} />
            <div className="mt-2 min-w-0">{words(step)}</div>
          </>,
          "relative z-10 flex w-full flex-col items-center px-1 pb-1.5 pt-0",
          ids.open(key),
        )}
      </li>
    );
  });

  const loopColumn = (loopKey: string) => MAIN.indexOf(LOOPS[loopKey] as (typeof MAIN)[number]) + 1;

  const loopConnector = (loopKey: string) => {
    const step = byKey.get(loopKey);
    if (!step) return null;
    const cycles = step.cycles ?? 0;
    const active = step.state === "current" || cycles > 0;
    // `cycles` counts the RETURNS; every return but the one HR is still reworking was followed by a resubmission
    const resubmitted = step.state === "current" ? Math.max(0, cycles - 1) : cycles;
    const back = resubmitted > 0;
    const edge = (on: boolean) => (on ? cn("border-solid", skin.edgeRework) : cn("border-dashed", skin.edgeIdle));
    return (
      <div
        key={`${loopKey}-arrows`}
        style={place(loopColumn(loopKey), 3)}
        className="relative flex h-12 justify-center"
        aria-hidden
      >
        <div className="relative flex h-full gap-5">
          <span className={cn("relative h-full border-l-2", edge(active))}>
            <ArrowDown
              size={12}
              strokeWidth={3}
              className={cn(
                "absolute -bottom-1 left-1/2 -translate-x-[calc(50%+1px)]",
                active ? skin.arrowRework : skin.arrowIdle,
              )}
            />
          </span>
          <span className={cn("relative h-full border-l-2", edge(back))}>
            <ArrowUp
              size={12}
              strokeWidth={3}
              className={cn(
                "absolute -top-1 left-1/2 -translate-x-[calc(50%+1px)]",
                back ? skin.arrowRework : skin.arrowIdle,
              )}
            />
          </span>
        </div>
        <span
          className={cn(
            "absolute right-[calc(50%+16px)] top-1/2 -translate-y-1/2 whitespace-nowrap text-[10px] font-semibold",
            active ? skin.detailRework : skin.inkMuted,
          )}
        >
          {cycles > 0 ? `Returned ${times(cycles)}` : step.state === "current" ? "Returned" : "Changes"}
        </span>
        <span
          className={cn(
            "absolute left-[calc(50%+16px)] top-1/2 -translate-y-1/2 whitespace-nowrap text-[10px] font-semibold",
            back ? skin.detailRework : skin.inkMuted,
          )}
        >
          {back ? `Resubmitted ${times(resubmitted)}` : "Resubmit"}
        </span>
      </div>
    );
  };

  const loopNode = (loopKey: string) => {
    const step = byKey.get(loopKey);
    if (!step) return null;
    return (
      <li
        key={loopKey}
        style={place(loopColumn(loopKey), 4)}
        className="relative flex flex-col items-center px-0.5 text-center"
        aria-current={step.state === "current" ? "step" : undefined}
        data-testid={ids.step(loopKey)}
        data-state={step.state}
        data-cycles={step.cycles ?? 0}
      >
        {node(
          step,
          <>
            <Dot step={step} skin={skin} />
            <div className="mt-2 min-w-0">{words(step)}</div>
          </>,
          "relative z-10 flex w-full flex-col items-center px-1 pb-1.5",
          ids.open(loopKey),
        )}
      </li>
    );
  };

  // the MD's approved path: through HR Final Settlement, or directly to the auditor (a fork over HR Final)
  const fork = (
    <div style={{ gridColumn: "3 / span 3", gridRow: 1 }} className="relative h-6" key="fork" aria-hidden>
      <div
        className={cn(
          "absolute bottom-0 left-[16.667%] right-[16.667%] top-2.5 rounded-t-2xl border-x-2 border-t-2",
          direct ? cn("border-solid", skin.edge) : cn("border-dashed", skin.edgeIdle),
        )}
      />
      <span
        className={cn(
          "absolute left-1/2 top-0 -translate-x-1/2 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-bold",
          direct ? skin.forkTaken : skin.fork,
        )}
        data-testid="flow-direct-path"
        data-taken={direct ? "yes" : viaHr ? "no" : "open"}
      >
        {direct
          ? "MD sent it directly to the auditor"
          : viaHr
            ? "Direct to auditor · not taken"
            : "or MD: direct to auditor"}
      </span>
    </div>
  );

  // ── the facts under the diagram ──
  const chips: { text: string; tone: "good" | "rework" | "plain"; id: string }[] = [];
  if (flow) {
    if (flow.mdPath)
      chips.push({
        id: "path",
        tone: "good",
        text: flow.mdPath === "direct" ? "Path: MD → directly to the auditor" : "Path: MD → HR Final → auditor",
      });
    if (flow.mdCycles > 0) chips.push({ id: "md-cycles", tone: "rework", text: `MD rework cycles: ${flow.mdCycles}` });
    if (flow.auditorCycles > 0)
      chips.push({ id: "auditor-cycles", tone: "rework", text: `Auditor rework cycles: ${flow.auditorCycles}` });
    if (flow.mdRound > 1) chips.push({ id: "md-round", tone: "plain", text: `MD review round ${flow.mdRound}` });
    if (flow.auditorRound > 1)
      chips.push({ id: "auditor-round", tone: "plain", text: `Auditor review round ${flow.auditorRound}` });
    if (flow.accountsVia)
      chips.push({
        id: "accounts",
        tone: "good",
        text: flow.accountsVia === "auditor" ? "Bank file sent by the auditor" : "Bank file sent by HR",
      });
  }
  const events = history;

  return (
    <div className="@container" data-testid={ids.root}>
      {/* wide: the branching diagram */}
      <ol className="hidden grid-cols-8 gap-x-1 @4xl:grid" aria-label={label}>
        {fork}
        {mainNodes}
        {Object.keys(LOOPS).map(loopConnector)}
        {Object.keys(LOOPS).map(loopNode)}
      </ol>

      {/* narrow: a list, the loops indented under their review */}
      <ol className="@4xl:hidden" aria-label={label}>
        {steps.map((step, i) => {
          const loop = Boolean(step.loop);
          // the main line runs on past a loop row to the next main stage
          const nextMain = steps.slice(i + 1).find((s) => !s.loop);
          return (
            <li
              key={step.key}
              className={cn("relative flex gap-3 pb-4 last:pb-0", loop && "pl-10")}
              aria-current={step.state === "current" ? "step" : undefined}
              data-testid={`${ids.step(step.key)}-row`}
              data-state={step.state}
            >
              {nextMain && (
                <span
                  aria-hidden
                  className={cn(
                    "absolute left-4 w-0.5 -translate-x-1/2",
                    loop ? "top-0 h-full" : "top-8 h-[calc(100%-2rem)]",
                    nextMain.state === "pending" ? skin.lineIdle : skin.line,
                  )}
                />
              )}
              {loop && (
                <CornerDownRight
                  aria-hidden
                  size={16}
                  className={cn(
                    "absolute left-[15px] top-1.5",
                    step.state === "current" || (step.cycles ?? 0) > 0 ? skin.arrowRework : skin.arrowIdle,
                  )}
                />
              )}
              {node(
                step,
                <>
                  <Dot
                    step={step}
                    number={MAIN.indexOf(step.key as (typeof MAIN)[number]) + 1}
                    skin={skin}
                    size={loop ? 7 : 8}
                  />
                  <div className="min-w-0 pt-1 text-left">
                    {words(step, true)}
                    {step.state === "current" && step.action && (
                      <p className={cn("mt-1 rounded-lg border px-2.5 py-1.5 text-[12px] font-medium", skin.next)}>
                        {step.action}
                      </p>
                    )}
                  </div>
                </>,
                "flex min-w-0 flex-1 gap-3 text-left",
                `${ids.open(step.key)}-row`,
              )}
            </li>
          );
        })}
      </ol>

      {showNext && current?.action && (
        <p
          className={cn("mt-4 hidden items-start gap-2 rounded-xl border px-3 py-2 text-[13px] @4xl:flex", skin.next)}
          data-testid={variant === "md" ? "md-settlement-next-action" : "tracker-next-action"}
        >
          <span className="font-bold">Next: </span>
          <span>{current.action}</span>
        </p>
      )}

      {(chips.length > 0 || events.length > 0) && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5" data-testid="flow-facts">
          {chips.map((c) => (
            <span
              key={c.id}
              className={cn(
                "inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-semibold",
                c.tone === "good" ? skin.chipGood : c.tone === "rework" ? skin.chipRework : skin.chip,
              )}
              data-testid={`flow-chip-${c.id}`}
            >
              {c.text}
            </span>
          ))}
          {events.length > 0 && (
            <button
              type="button"
              onClick={() => setHistoryOpen((v) => !v)}
              aria-expanded={historyOpen}
              className={cn(
                "ml-auto inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2",
                skin.chip,
                skin.hover,
                skin.focus,
              )}
              data-testid="flow-history-toggle"
            >
              <History size={12} aria-hidden />
              Approval history ({events.length})
              <ChevronDown size={12} aria-hidden className={cn("transition-transform", historyOpen && "rotate-180")} />
            </button>
          )}
        </div>
      )}

      {historyOpen && events.length > 0 && (
        <ol className={cn("mt-2 space-y-0 rounded-xl border p-3", skin.panel)} data-testid="flow-history">
          {events.map((h, i) => {
            const { text, tone } = historyLabel(h);
            return (
              <li key={`${h.at}-${i}`} className="relative flex gap-3 pb-3 last:pb-0">
                {i < events.length - 1 && (
                  <span aria-hidden className={cn("absolute left-[5px] top-3 h-full w-0.5", skin.lineIdle)} />
                )}
                <span
                  aria-hidden
                  className={cn(
                    "relative z-10 mt-1 h-2.5 w-2.5 shrink-0 rounded-full",
                    tone === "good"
                      ? skin.done
                      : tone === "rework"
                        ? skin.rework
                        : tone === "send"
                          ? skin.current
                          : skin.pending,
                    "ring-0",
                  )}
                />
                <div className="min-w-0">
                  <p className={cn("text-[12.5px] font-semibold leading-snug", skin.ink)}>{text}</p>
                  <p className={cn("text-[11px] leading-snug", skin.inkSoft)}>
                    {[when(h.at), h.by].filter(Boolean).join(" · ")}
                  </p>
                  {h.note ? <p className={cn("mt-0.5 text-[11.5px] leading-snug", skin.inkSoft)}>“{h.note}”</p> : null}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
