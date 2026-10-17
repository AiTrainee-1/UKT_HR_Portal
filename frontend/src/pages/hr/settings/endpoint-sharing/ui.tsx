import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, Copy, Info, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Problem } from "../compensation/ui";
import { copyText, selectAll } from "./clipboard";

export { Problem };

/** A coloured strip of explanation. `warn` is amber (be careful), `danger` red, `info` slate. */
export function Notice({
  tone = "info",
  title,
  children,
  testId,
}: {
  tone?: "info" | "warn" | "danger" | "good";
  title?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  const style = {
    info: "bg-slate-50 text-slate-700 ring-slate-200",
    warn: "bg-amber-50 text-amber-900 ring-amber-200",
    danger: "bg-red-50 text-red-800 ring-red-200",
    good: "bg-emerald-50 text-emerald-900 ring-emerald-200",
  }[tone];
  const Icon = tone === "warn" || tone === "danger" ? TriangleAlert : Info;
  return (
    <div
      className={cn("flex items-start gap-2 rounded-lg px-3 py-2.5 text-[13px] leading-snug ring-1", style)}
      data-testid={testId}
      data-tone={tone}
    >
      <Icon size={15} className="mt-0.5 shrink-0" />
      <div className="min-w-0 space-y-1">
        {title && <p className="font-semibold">{title}</p>}
        <div>{children}</div>
      </div>
    </div>
  );
}

/** A small round-cornered label: "On", "Off", "Active", "Revoked". */
export function Pill({
  tone,
  children,
  testId,
}: {
  tone: "good" | "bad" | "muted" | "warn";
  children: ReactNode;
  testId?: string;
}) {
  const style = {
    good: "bg-emerald-50 text-emerald-800 ring-emerald-200",
    bad: "bg-red-50 text-red-800 ring-red-200",
    muted: "bg-slate-100 text-slate-600 ring-slate-200",
    warn: "bg-amber-50 text-amber-800 ring-amber-200",
  }[tone];
  return (
    <span
      data-testid={testId}
      className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1", style)}
    >
      {children}
    </span>
  );
}

/**
 * Copies `text`. When the browser refuses (no clipboard permission, an address that is not https), the text in `target`
 * is selected and the button says to press Ctrl+C: a copy button that silently does nothing is the worst kind.
 */
export function CopyButton({
  text,
  label = "Copy",
  target,
  testId,
  size = "sm",
}: {
  text: string;
  label?: string;
  /** The element that shows the text: selected when copying is refused. */
  target?: React.RefObject<HTMLElement | null>;
  testId?: string;
  size?: "sm" | "default";
}) {
  const [state, setState] = useState<"idle" | "copied" | "refused">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    const done = await copyText(text);
    if (!done) selectAll(target?.current ?? null);
    setState(done ? "copied" : "refused");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), done ? 2000 : 6000);
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        type="button"
        size={size}
        variant="outline"
        onClick={() => void copy()}
        className="gap-1.5"
        data-testid={testId}
      >
        {state === "copied" ? <Check size={13} /> : <Copy size={13} />}
        {state === "copied" ? "Copied" : label}
      </Button>
      <span role="status" aria-live="polite" className="text-xs font-medium text-amber-800">
        {state === "refused" ? "Your browser blocked copying. The text is selected: press Ctrl+C." : ""}
      </span>
    </span>
  );
}

/** A block of code or a long value in a box that scrolls sideways inside itself, with its Copy button. */
export function CodeBox({
  code,
  label,
  testId,
  copyLabel = "Copy",
}: {
  code: string;
  /** Read out by a screen reader and shown above the box. */
  label?: string;
  testId?: string;
  copyLabel?: string;
}) {
  const ref = useRef<HTMLPreElement>(null);
  return (
    <div className="space-y-1.5" data-testid={testId}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {label ? <span className="text-xs font-semibold text-slate-600">{label}</span> : <span />}
        <CopyButton text={code} label={copyLabel} target={ref} testId={testId ? `${testId}-copy` : undefined} />
      </div>
      <pre
        ref={ref}
        tabIndex={0}
        aria-label={label ?? "Code"}
        className="max-w-full overflow-x-auto rounded-lg bg-slate-900 p-3 text-[12px] leading-relaxed text-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400"
      >
        <code>{code}</code>
      </pre>
    </div>
  );
}

/**
 * The nested subtabs of the editor, in the page address (`section=`). The same look as the Compensation page's nested tabs
 * (a thin underlined row), the same keys (Left / Right / Home / End), but it reports the choice instead of changing a path,
 * because here the choice lives in the query string of the Settings page.
 */
export function NestedStrip({
  items,
  value,
  onChange,
  testId,
  label,
}: {
  items: { value: string; label: string }[];
  value: string;
  onChange: (next: string) => void;
  testId: string;
  label: string;
}) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const active = Math.max(
    0,
    items.findIndex((i) => i.value === value),
  );
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let to = index;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") to = (index + 1) % items.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") to = (index - 1 + items.length) % items.length;
    else if (event.key === "Home") to = 0;
    else if (event.key === "End") to = items.length - 1;
    else return;
    event.preventDefault();
    buttons.current[to]?.focus();
    if (items[to].value !== value) onChange(items[to].value);
  };
  return (
    <div className="max-w-full overflow-x-auto border-b border-slate-200" data-testid={`${testId}-strip`}>
      <div role="tablist" aria-label={label} className="flex w-max min-w-full gap-1" data-testid={testId}>
        {items.map((item, index) => {
          const on = index === active;
          return (
            <button
              key={item.value}
              ref={(el) => {
                buttons.current[index] = el;
              }}
              type="button"
              role="tab"
              id={`${testId}-tab-${item.value}`}
              aria-selected={on}
              aria-controls={`${testId}-panel`}
              tabIndex={on ? 0 : -1}
              onClick={() => onChange(item.value)}
              onKeyDown={(event) => onKeyDown(event, index)}
              data-testid={`${testId}-${item.value}`}
              className={cn(
                "-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-xs font-semibold outline-none transition-colors",
                "focus-visible:rounded-t-md focus-visible:ring-2 focus-visible:ring-ring",
                on
                  ? "border-indigo-600 text-indigo-700"
                  : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800",
              )}
            >
              {item.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * A table inside its own box (the page itself never scrolls sideways).
 *
 * Default: every column keeps its full width and the box scrolls, which suits data of unknown width (the preview).
 * `fit`: for tables whose cells are sentences or addresses (guides, the access log): the columns share the box and their text
 * wraps, so nothing is hidden behind a sideways scroll at laptop width; below 640 px every row becomes a small card whose
 * cells are labelled with their column's name (each `<td>` of a `fit` table carries `data-label`). The box still scrolls
 * as a last resort.
 */
export function ScrollTable({
  children,
  testId,
  label,
  fit = false,
}: {
  children: ReactNode;
  testId?: string;
  label: string;
  fit?: boolean;
}) {
  return (
    <div
      className="max-w-full overflow-x-auto rounded-lg border border-slate-200"
      tabIndex={0}
      role="region"
      aria-label={label}
      data-testid={testId}
      data-fit={fit ? "true" : undefined}
    >
      <table className={fit ? FIT_TABLE : "w-full min-w-max border-collapse text-left text-[12.5px]"}>{children}</table>
    </div>
  );
}

const FIT_TABLE = [
  "w-full border-collapse text-left text-[12.5px]",
  "max-sm:[&_thead]:sr-only max-sm:[&_tr]:block max-sm:[&_tbody_tr]:border-b max-sm:[&_tbody_tr]:border-slate-200 max-sm:[&_tbody_tr]:py-1.5",
  "max-sm:[&_td]:flex max-sm:[&_td]:items-start max-sm:[&_td]:justify-between max-sm:[&_td]:gap-3 max-sm:[&_td]:border-b-0 max-sm:[&_td]:py-1 max-sm:[&_td]:text-right",
  "max-sm:[&_td]:before:shrink-0 max-sm:[&_td]:before:text-left max-sm:[&_td]:before:text-[11px] max-sm:[&_td]:before:font-semibold max-sm:[&_td]:before:uppercase max-sm:[&_td]:before:tracking-wide max-sm:[&_td]:before:text-slate-500 max-sm:[&_td]:before:content-[attr(data-label)]",
].join(" ");

export const TH =
  "border-b border-slate-200 bg-slate-50 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500";
export const TD = "border-b border-slate-100 px-3 py-2 align-top text-slate-800";
/** For addresses, codes and other text with no spaces in it: it breaks anywhere instead of widening its column. */
export const WRAP = "[overflow-wrap:anywhere]";

/** The language label for a sensitivity, as a pill. */
export function SensitivityPill({ level }: { level: "basic" | "personal" | "financial" }) {
  return (
    <Pill tone={level === "basic" ? "muted" : level === "personal" ? "warn" : "bad"}>
      {level === "basic" ? "Basic" : level === "personal" ? "Personal" : "Financial"}
    </Pill>
  );
}

/**
 * A card of the tab that the page's search can jump to: a heading, one lead sentence saying what it is for, then the content.
 * Same anchors as a SettingBlock (`data-setting-id`), but the content has the whole width (a list, a table, a guide).
 */
export function AnchorSection({
  id,
  title,
  purpose,
  children,
  testId,
  actions,
}: {
  id: string;
  title: ReactNode;
  purpose: ReactNode;
  children?: ReactNode;
  testId?: string;
  /** Buttons at the top right of the heading. */
  actions?: ReactNode;
}) {
  return (
    <section
      id={id}
      data-setting-id={id}
      data-testid={testId ?? id}
      className="settings-glass scroll-mt-24 space-y-3 rounded-xl p-4 sm:p-6 [&.setting-flash]:ring-2 [&.setting-flash]:ring-sky-300"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-64 space-y-1">
          <h4 className="text-[15px] font-semibold leading-tight text-slate-900">{title}</h4>
          <p className="text-[13px] leading-relaxed text-slate-500" data-testid="setting-purpose">
            {purpose}
          </p>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

/** Shared box styles. */
export const SELECT_CLASS = "h-9 w-full rounded-md border bg-white px-2 text-sm disabled:opacity-50";
