import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { AlertTriangle, ChevronDown, Database, FileSearch, ListChecks, ShieldCheck, Sparkles } from "lucide-react";
import { num } from "@/lib/md/format";
import { cn } from "@/lib/utils";
import type { AnswerPayload, Confidence } from "./api";

const CONFIDENCE: Record<Confidence, { label: string; chip: string }> = {
  high: { label: "High confidence", chip: "bg-green-100 text-green-800" },
  medium: { label: "Medium confidence", chip: "bg-amber-100 text-amber-800" },
  low: { label: "Low confidence", chip: "bg-red-100 text-red-800" },
};

type Tab = "did" | "data" | "assume";

export function ConfidenceChip({ payload }: { payload: AnswerPayload }) {
  if (!payload.confidence) return null;
  const c = CONFIDENCE[payload.confidence];
  return (
    <span
      className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[10.5px] font-bold", c.chip)}
      title={payload.confidenceReason}
      data-testid="assistant-confidence"
    >
      {c.label}
    </span>
  );
}

/** "How I got this": the explainable part of an answer. Everything here is built by the server from the lookups that
 *  really happened (steps, data used, caveats): the assistant's own words are shown separately and labelled as such. */
export default function Explainer({ payload }: { payload: AnswerPayload }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("did");
  const reduce = useReducedMotion();
  const steps = payload.steps ?? [];
  const data = payload.dataUsed ?? [];
  const assumptions = payload.assumptions ?? [];
  if (steps.length === 0 && data.length === 0 && assumptions.length === 0 && !payload.reasoning?.length) return null;

  const tabs: { id: Tab; label: string; icon: typeof Database; count: number }[] = [
    { id: "did", label: "What I did", icon: ListChecks, count: steps.length },
    { id: "data", label: "Data used", icon: Database, count: data.length },
    { id: "assume", label: "Assumptions", icon: FileSearch, count: assumptions.length },
  ];

  return (
    <div className="rounded-xl border border-[#006496]/12 bg-[#f6fafe]" data-testid="assistant-explainer">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        data-testid="assistant-explain-toggle"
      >
        <Sparkles size={13} className="shrink-0 text-[#c18a1f]" />
        <span className="flex-1 text-[12px] font-bold text-[#006496]">How I got this</span>
        <span className="text-[11px] text-[#006496]/55">
          {steps.length} lookup{steps.length === 1 ? "" : "s"}
        </span>
        <ChevronDown
          size={14}
          className={cn("shrink-0 text-[#006496]/50 transition-transform", open && "rotate-180")}
        />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={reduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduce ? undefined : { height: 0, opacity: 0 }}
            transition={{ duration: 0.22 }}
            className="overflow-hidden"
          >
            <div className="border-t border-[#006496]/10 px-3 pb-3 pt-2">
              <div className="mb-2.5 flex gap-1 overflow-x-auto pb-0.5" role="tablist">
                {tabs.map((t) => (
                  <button
                    key={t.id}
                    role="tab"
                    type="button"
                    aria-selected={tab === t.id}
                    onClick={() => setTab(t.id)}
                    data-testid={`explain-tab-${t.id}`}
                    className={cn(
                      "flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-bold transition-colors",
                      tab === t.id ? "bg-[#006496] text-white" : "bg-white text-[#006496]/70 hover:bg-[#006496]/[0.07]",
                    )}
                  >
                    <t.icon size={11} />
                    {t.label}
                    <span className={cn("tabular-nums", tab === t.id ? "text-white/70" : "text-[#006496]/45")}>
                      {t.count}
                    </span>
                  </button>
                ))}
              </div>

              {tab === "did" && (
                <div className="space-y-3">
                  <ol className="space-y-2" data-testid="explain-steps">
                    {steps.map((step, i) => (
                      <li key={i} className="flex gap-2.5">
                        <span
                          className={cn(
                            "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-extrabold",
                            step.ok ? "bg-[#006496]/10 text-[#006496]" : "bg-amber-100 text-amber-800",
                          )}
                        >
                          {i + 1}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-[12.5px] font-semibold text-[#1a3a4a]">{step.title}</p>
                          {step.detail && <p className="text-[11.5px] italic text-[#1a3a4a]/70">{step.detail}</p>}
                          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10.5px] text-[#006496]/70">
                            {step.period && <span className="rounded-full bg-white px-1.5 py-0.5">{step.period}</span>}
                            {step.scope && step.scope !== "All units · all departments · staff and production" && (
                              <span className="rounded-full bg-white px-1.5 py-0.5">{step.scope}</span>
                            )}
                            {step.rows != null && <span>{num(step.rows)} records</span>}
                            {step.ms > 0 && <span>{step.ms} ms</span>}
                          </div>
                          {!step.ok && (
                            <p className="mt-0.5 flex items-center gap-1 text-[11px] text-amber-800">
                              <AlertTriangle size={11} /> This lookup could not be completed
                              {step.error ? `: ${step.error}` : "."}
                            </p>
                          )}
                        </div>
                      </li>
                    ))}
                    {steps.length === 0 && (
                      <li className="text-[12px] text-[#1a3a4a]/60">No data lookups were needed for this reply.</li>
                    )}
                  </ol>
                  {!!payload.reasoning?.length && (
                    <div className="rounded-lg bg-white p-2.5">
                      <p className="mb-1 text-[10px] font-extrabold uppercase tracking-wider text-[#006496]/55">
                        In the assistant&apos;s words
                      </p>
                      <ul className="space-y-1 text-[12px] text-[#1a3a4a]/85">
                        {payload.reasoning.map((line, i) => (
                          <li key={i} className="flex gap-1.5">
                            <span className="text-[#c18a1f]">›</span>
                            <span>{line}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {tab === "data" && (
                <ul className="space-y-2" data-testid="explain-data">
                  {data.map((d, i) => (
                    <li key={i} className="rounded-lg bg-white p-2.5">
                      <p className="text-[12.5px] font-bold text-[#1a3a4a]">{d.title}</p>
                      <p className="text-[11px] text-[#006496]/70">
                        {d.dataset}
                        {d.rows != null ? ` · ${num(d.rows)} records` : ""}
                        {d.period ? ` · ${d.period}` : ""}
                      </p>
                      {d.definition && <p className="mt-1 text-[12px] text-[#1a3a4a]/85">{d.definition}</p>}
                      {d.formula && (
                        <p className="mt-1 rounded bg-[#006496]/[0.06] px-1.5 py-1 font-mono text-[11px] text-[#1a3a4a]">
                          {d.formula}
                        </p>
                      )}
                      {d.filters.length > 0 && (
                        <p className="mt-1 text-[11px] text-[#1a3a4a]/65">Filters: {d.filters.join("; ")}</p>
                      )}
                      {d.caveats.map((c, n) => (
                        <p key={n} className="mt-1 flex items-start gap-1 text-[11px] text-amber-800">
                          <AlertTriangle size={11} className="mt-0.5 shrink-0" /> {c}
                        </p>
                      ))}
                    </li>
                  ))}
                  {data.length === 0 && (
                    <li className="text-[12px] text-[#1a3a4a]/60">No company data was used in this reply.</li>
                  )}
                </ul>
              )}

              {tab === "assume" && (
                <div className="space-y-2" data-testid="explain-assumptions">
                  <ul className="space-y-1 text-[12px] text-[#1a3a4a]/85">
                    {assumptions.map((a, i) => (
                      <li key={i} className="flex gap-1.5">
                        <span className="text-[#c18a1f]">›</span>
                        <span>{a}</span>
                      </li>
                    ))}
                    {assumptions.length === 0 && (
                      <li className="text-[#1a3a4a]/60">Nothing was assumed beyond your question.</li>
                    )}
                  </ul>
                  {payload.confidenceReason && (
                    <p className="rounded-lg bg-white p-2 text-[11.5px] text-[#1a3a4a]/80">
                      {payload.confidenceReason}
                    </p>
                  )}
                  {payload.privacy?.enabled && (
                    <p className="flex items-start gap-1.5 text-[11px] text-[#006496]/75">
                      <ShieldCheck size={12} className="mt-0.5 shrink-0 text-green-600" />
                      Employee names were replaced with codes before anything was sent to Google Gemini, and put back
                      here for you.
                    </p>
                  )}
                  {payload.usage && (
                    <p className="text-[10.5px] text-[#006496]/50">
                      {payload.model} · {payload.usage.requests} request{payload.usage.requests === 1 ? "" : "s"} ·{" "}
                      {num(payload.usage.promptTokens + payload.usage.outputTokens)} tokens
                    </p>
                  )}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
