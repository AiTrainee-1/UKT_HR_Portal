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
    <div className={cn("flex flex-col items-center gap-3 px-6 py-10 text-center", className)} data-testid={testId}>
      <div className="rounded-2xl bg-blue-50 p-3.5 text-[#006496]">
        <Icon size={22} />
      </div>
      <div>
        <p className="font-bold text-gray-900">{title}</p>
        {children && <p className="mx-auto mt-0.5 max-w-md text-sm text-muted-foreground">{children}</p>}
      </div>
      {action}
    </div>
  );
}

/** A failed load: what the server said, and a retry. */
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
      className={cn("flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-red-800", className)}
      data-testid="md-error"
    >
      <AlertTriangle size={18} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">This could not be loaded.</p>
        <p className="mt-0.5 text-xs">{message}</p>
      </div>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry} className="shrink-0 gap-1.5 bg-white">
          <RefreshCw size={13} /> Retry
        </Button>
      )}
    </div>
  );
}

/** A caveat worth reading before trusting the numbers (data not computed, a rule that is switched off...). */
export function NoteBanner({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900",
        className,
      )}
      data-testid="md-note"
    >
      <AlertTriangle size={14} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
