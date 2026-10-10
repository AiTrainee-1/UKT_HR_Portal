import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { AlertTriangle, ChevronDown, ShieldAlert, ShieldCheck, ShieldX, Sparkles } from "lucide-react";
import { num } from "@/lib/md/format";
import { cn } from "@/lib/utils";
import type { AnswerPayload, Confidence } from "./api";

/** Good / watch / bad, in the portal's meaning of those colours (sage, ochre, crimson). The words carry it as well. */
const CONFIDENCE: Record<Confidence, { label: string; chip: string; icon: typeof ShieldCheck }> = {
  high: { label: "High confidence", chip: "md-chip-success", icon: ShieldCheck },
  medium: { label: "Medium confidence", chip: "md-chip-warning", icon: ShieldAlert },
  low: { label: "Low confidence", chip: "md-chip-danger", icon: ShieldX },
};

type Tab = "did" | "data" | "assume";

export function ConfidenceChip({ payload }: { payload: AnswerPayload }) {
  if (!payload.confidence) return null;
  const c = CONFIDENCE[payload.confidence];
  return (
    <span className={cn("md-chip", c.chip)} title={payload.confidenceReason} data-testid="assistant-confidence">
      <c.icon size={11} aria-hidden />
      {c.label}
    </span>
  );
}

/** "How I got this": the explainable part of an answer. Everything here is built by the server from the lookups that
 *  really happened (steps, data used, caveats): the assistant's own words are shown separately (wine tint) and labelled
 *  as such. A sand panel under the answer's glass card, with white inner panels for each fact. */
export default function Explainer({ payload }: { payload: AnswerPayload }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("did");
  const reduce = useReducedMotion();
  const steps = payload.steps ?? [];
  const data = payload.dataUsed ?? [];
  const assumptions = payload.assumptions ?? [];
  if (steps.length === 0 && data.length === 0 && assumptions.length === 0 && !payload.reasoning?.length) return null;

  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: "did", label: "What I did", count: steps.length },
    { id: "data", label: "Data used", count: data.length },
    { id: "assume", label: "Assumptions", count: assumptions.length },
  ];

  return (
    <div className="md-panel-sand overflow-hidden" data-testid="assistant-explainer">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="md-assistant-explain-toggle flex w-full items-center gap-2.5 px-3 py-2.5 text-left"
        data-testid="assistant-explain-toggle"
      >
        <span className="md-icon-tile md-assistant-tile-sm h-7 w-7 shrink-0">
          <Sparkles size={13} />
        </span>
        <span className="flex-1 text-[12.5px] font-extrabold text-md-wine-700">How I got this</span>
        <span className="text-[11.5px] tabular-nums text-md-ink-soft">
          {steps.length} lookup{steps.length === 1 ? "" : "s"}
        </span>
        <ChevronDown
          size={15}
          className={cn("shrink-0 text-md-ink-soft transition-transform duration-200", open && "rotate-180")}
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
            <div className="border-t border-md-warning-400/20 px-3 pb-3 pt-3">
              <div className="md-assistant-tabs-scroll">
                <div className="md-seg md-assistant-tabs" role="tablist">
                  {tabs.map((t) => (
                    <button
                      key={t.id}
                      role="tab"
                      type="button"
                      aria-selected={tab === t.id}
                      onClick={() => setTab(t.id)}
                      data-testid={`explain-tab-${t.id}`}
                      className="md-seg-item"
                    >
                      {t.label}
                      <span className="tabular-nums opacity-75">{t.count}</span>
                    </button>
                  ))}
                </div>
              </div>

              {tab === "did" && (
                <div className="space-y-3">
                  <ol className="space-y-3" data-testid="explain-steps">
                    {steps.map((step, i) => (
                      <li key={i} className="flex gap-2.5">
                        <span className={cn("md-assistant-step-no", !step.ok && "is-warn")}>{i + 1}</span>
                        <div className="min-w-0 flex-1">
                          <p className="text-[13px] font-bold leading-snug text-md-ink">{step.title}</p>
                          {step.detail && (
                            <p className="mt-0.5 text-[12px] italic leading-snug text-md-ink-soft">{step.detail}</p>
                          )}
                          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11.5px] text-md-ink-soft">
                            {step.period && <span className="md-chip">{step.period}</span>}
                            {step.scope && step.scope !== "All units · all departments · staff and production" && (
                              <span className="md-chip">{step.scope}</span>
                            )}
                            {step.rows != null && <span className="tabular-nums">{num(step.rows)} records</span>}
                            {step.ms > 0 && <span className="tabular-nums">{step.ms} ms</span>}
                          </div>
                          {!step.ok && (
                            <p className="mt-1 flex items-start gap-1.5 text-[12px] font-semibold text-md-warning-800">
                              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                              <span>
                                This lookup could not be completed
                                {step.error ? `: ${step.error}` : "."}
                              </span>
                            </p>
                          )}
                        </div>
                      </li>
                    ))}
                    {steps.length === 0 && (
                      <li className="text-[12.5px] text-md-ink-soft">No data lookups were needed for this reply.</li>
                    )}
                  </ol>
                  {!!payload.reasoning?.length && (
                    <div className="md-panel-wine p-3">
                      <p className="md-assistant-overline md-assistant-overline-wine mb-1.5">
                        In the assistant&apos;s words
                      </p>
                      <ul className="space-y-1.5 text-[12.5px] leading-snug text-md-ink">
                        {payload.reasoning.map((line, i) => (
                          <li key={i} className="flex gap-1.5">
                            <span className="font-bold text-md-wine-500" aria-hidden>
                              ›
                            </span>
                            <span>{line}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {tab === "data" && (
                <ul className="space-y-2.5" data-testid="explain-data">
                  {data.map((d, i) => (
                    <li key={i} className="md-panel p-3">
                      <p className="text-[13px] font-bold leading-snug text-md-ink">{d.title}</p>
                      <p className="mt-0.5 text-[11.5px] text-md-ink-soft">
                        {d.dataset}
                        {d.rows != null ? ` · ${num(d.rows)} records` : ""}
                        {d.period ? ` · ${d.period}` : ""}
                      </p>
                      {d.definition && <p className="mt-1.5 text-[12.5px] leading-snug text-md-ink">{d.definition}</p>}
                      {d.formula && <p className="md-assistant-formula mt-1.5 px-2 py-1 text-[11.5px]">{d.formula}</p>}
                      {d.filters.length > 0 && (
                        <p className="mt-1.5 text-[11.5px] text-md-ink-soft">Filters: {d.filters.join("; ")}</p>
                      )}
                      {d.caveats.map((c, n) => (
                        <p
                          key={n}
                          className="mt-1.5 flex items-start gap-1.5 text-[11.5px] font-semibold text-md-warning-800"
                        >
                          <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {c}
                        </p>
                      ))}
                    </li>
                  ))}
                  {data.length === 0 && (
                    <li className="text-[12.5px] text-md-ink-soft">No company data was used in this reply.</li>
                  )}
                </ul>
              )}

              {tab === "assume" && (
                <div className="space-y-2.5" data-testid="explain-assumptions">
                  <ul className="space-y-1.5 text-[12.5px] leading-snug text-md-ink">
                    {assumptions.map((a, i) => (
                      <li key={i} className="flex gap-1.5">
                        <span className="font-bold text-md-wine-500" aria-hidden>
                          ›
                        </span>
                        <span>{a}</span>
                      </li>
                    ))}
                    {assumptions.length === 0 && (
                      <li className="text-md-ink-soft">Nothing was assumed beyond your question.</li>
                    )}
                  </ul>
                  {payload.confidenceReason && (
                    <p className="md-panel p-2.5 text-[12px] leading-snug text-md-ink">{payload.confidenceReason}</p>
                  )}
                  {payload.privacy?.enabled && (
                    <p className="flex items-start gap-1.5 text-[11.5px] leading-snug text-md-ink-soft">
                      <ShieldCheck size={13} className="mt-0.5 shrink-0 text-md-success" />
                      Employee names were replaced with codes before anything was sent to Google Gemini, and put back
                      here for you.
                    </p>
                  )}
                  {payload.usage && (
                    <p className="text-[11px] tabular-nums text-md-ink-soft">
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
