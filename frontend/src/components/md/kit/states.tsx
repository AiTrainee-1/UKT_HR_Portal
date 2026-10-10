import type { ComponentType, ReactNode } from "react";
import { AlertTriangle, Inbox, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Nothing to show (yet): an icon tile, a plain explanation and, optionally, what to do about it. */
export function EmptyBlock({
  icon: Icon = Inbox,
  title,
  children,
  action,
  className,
  testId,
}: {
  icon?: ComponentType<{ size?: number }>;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center gap-3.5 px-6 py-10 text-center", className)} data-testid={testId}>
      <div className="md-shell-empty-tile">
        <Icon size={22} />
      </div>
      <div>
        <p className="text-[15px] font-extrabold tracking-tight text-md-ink">{title}</p>
        {children && <p className="mx-auto mt-1 max-w-md text-[13px] leading-relaxed text-md-ink-soft">{children}</p>}
      </div>
      {action}
    </div>
  );
}

/** A quiet placeholder while the first load of a card is on its way: sand bars that breathe, in the shape of a title, a
 *  figure and a few rows. It is announced as "Loading". */
export function SkeletonBlock({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div
      role="status"
      aria-label="Loading"
      className={cn("flex min-h-[140px] flex-col justify-center gap-3 py-2", className)}
    >
      <div className="clay-skeleton h-4 w-2/5" />
      <div className="clay-skeleton h-8 w-3/5" />
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="clay-skeleton h-3" style={{ width: `${92 - i * 14}%` }} />
      ))}
    </div>
  );
}

/** A failed load: what the server said, and a retry. Crimson glass: crimson means "bad", the brand wine never does. */
export function ErrorBanner({
  message,
  onRetry,
  className,
}: {
  message: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn("md-shell-error flex items-start gap-3 rounded-2xl p-4 text-md-danger-800", className)}
      data-testid="md-error"
    >
      <span className="md-shell-banner-tile md-shell-banner-danger">
        <AlertTriangle size={16} />
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        <p className="text-sm font-bold">This could not be loaded.</p>
        <p className="mt-0.5 text-xs leading-relaxed">{message}</p>
      </div>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry} className="shrink-0 gap-1.5">
          <RefreshCw size={13} /> Retry
        </Button>
      )}
    </div>
  );
}

/** A caveat worth reading before trusting the numbers (data not computed, a rule that is switched off...): a sand panel
 *  with an ochre icon. */
export function NoteBanner({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "md-panel-sand flex items-start gap-2.5 p-3 text-xs leading-relaxed text-md-warning-800",
        className,
      )}
      data-testid="md-note"
    >
      <AlertTriangle size={14} className="mt-0.5 shrink-0 text-md-warning-600" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
