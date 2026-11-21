import type { ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import { EmptyBlock, ErrorBanner } from "@/components/md/kit/states";
import { CircleLoader } from "@/components/ui/CircleLoader";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

/**
 * The drill-down of an Insights tab: the MD clicks a figure, a group, an employee or a record and its detail opens in a
 * side sheet (full width on a phone) over the tab, which stays as it was. Optional: a way on to the HR page itself (`open`,
 * e.g. "Open in Requests") and an Ask AI question about what the sheet shows.
 */
export default function DetailSheet({
  open,
  onClose,
  title,
  subtitle,
  loading,
  error,
  onRetry,
  empty,
  ask,
  openLabel,
  onOpen,
  children,
  testId = "md-insights-detail",
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  loading?: boolean;
  /** A readable reason the detail could not be loaded. */
  error?: string | null;
  onRetry?: () => void;
  /** Said when there is nothing to list. */
  empty?: string | null;
  ask?: string;
  openLabel?: string;
  onOpen?: () => void;
  children?: ReactNode;
  testId?: string;
  /** Room for a table (a wider sheet on a large screen). */
  wide?: boolean;
}) {
  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent
        className={cn("md-analytics-sheet w-full overflow-y-auto", wide ? "sm:max-w-2xl" : "sm:max-w-lg")}
        data-testid={testId}
      >
        <div className="space-y-4">
          <div className="pr-8">
            <SheetTitle className="text-lg font-black leading-tight text-md-ink">{title}</SheetTitle>
            <SheetDescription className={cn("mt-1 text-[13px] text-md-ink-soft", !subtitle && "sr-only")}>
              {subtitle ?? "Details"}
            </SheetDescription>
          </div>
          {(ask || onOpen) && (
            <div className="flex flex-wrap items-center gap-2">
              {onOpen && (
                <button
                  type="button"
                  className="md-btn inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold"
                  onClick={onOpen}
                  data-testid={`${testId}-open`}
                >
                  {openLabel ?? "Open the page"} <ArrowUpRight size={14} aria-hidden />
                </button>
              )}
              {ask && <AskAiButton question={ask} label="Ask AI" />}
            </div>
          )}
          {error ? (
            <ErrorBanner message={error} onRetry={onRetry} />
          ) : loading ? (
            <div className="flex min-h-[180px] items-center justify-center" data-testid={`${testId}-loading`}>
              <CircleLoader texts={["UK Textiles", "Details", "Loading"]} />
            </div>
          ) : empty ? (
            <EmptyBlock title="Nothing to show" testId={`${testId}-empty`}>
              {empty}
            </EmptyBlock>
          ) : (
            children
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** One line of a drill-down list: a name and its detail on the left, a figure on the right; clickable when `onClick`. */
export function DetailRow({
  primary,
  secondary,
  value,
  tone,
  onClick,
  testId,
}: {
  primary: ReactNode;
  secondary?: ReactNode;
  value?: ReactNode;
  /** md-analytics-tone-* class for the figure. */
  tone?: string;
  onClick?: () => void;
  testId?: string;
}) {
  const body = (
    <>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-semibold text-md-ink">{primary}</span>
        {secondary && <span className="block truncate text-xs text-md-ink-soft">{secondary}</span>}
      </span>
      {value !== undefined && (
        <span className={cn("shrink-0 text-[13px] font-bold tabular-nums text-md-ink", tone)}>{value}</span>
      )}
    </>
  );
  return (
    <li data-testid={testId}>
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-md-wine/5 focus-visible:bg-md-wine/5"
        >
          {body}
        </button>
      ) : (
        <div className="flex items-center gap-3 px-3 py-2.5">{body}</div>
      )}
    </li>
  );
}

/** The list a DetailSheet usually holds: hairline-separated rows on a panel. */
export function DetailList({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <ul className="md-panel divide-y divide-md-line" data-testid={testId}>
      {children}
    </ul>
  );
}
