import { useLayoutEffect, useRef, type ReactNode } from "react";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

/**
 * The details of one row, in a panel from the right (the whole width on a phone): a title, a one-line subtitle, sections
 * and the actions at the bottom. It is a dialog: focus moves into it, Tab stays inside, Esc or the X closes it, and focus
 * goes back to what had it before (the row that opened it: the drawer is opened by state, not by a Radix trigger, so it
 * remembers that element itself).
 */
export function DetailDrawer({
  open,
  onOpenChange,
  title,
  subtitle,
  children,
  footer,
  wide = false,
  testId = "detail-drawer",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  /** The actions (Check out, Close ...), right-aligned at the bottom; they wrap on a phone. */
  footer?: ReactNode;
  /** A wider panel (36 rem instead of 28) for a drawer with a table in it. */
  wide?: boolean;
  testId?: string;
}) {
  // what had the focus when the drawer opened (layout effects run before Radix moves the focus inside)
  const returnTo = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (open) returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }, [open]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className={cn(
          "flex w-full flex-col gap-0 p-0",
          wide ? "sm:max-w-xl" : "sm:max-w-md",
          // the close button: a 44 px target in the corner
          "[&>[data-slot=sheet-close]]:right-1.5 [&>[data-slot=sheet-close]]:top-1.5 [&>[data-slot=sheet-close]]:flex [&>[data-slot=sheet-close]]:size-11 [&>[data-slot=sheet-close]]:items-center [&>[data-slot=sheet-close]]:justify-center",
        )}
        data-testid={testId}
        onCloseAutoFocus={(event) => {
          const target = returnTo.current;
          if (target?.isConnected) {
            event.preventDefault();
            target.focus();
          }
        }}
        {...(subtitle ? {} : { "aria-describedby": undefined })}
      >
        <div className="border-b border-slate-100 py-4 pl-5 pr-14">
          <SheetTitle className="truncate text-base font-semibold text-slate-900">{title}</SheetTitle>
          {subtitle && (
            <SheetDescription className="mt-0.5 truncate text-sm text-slate-500">{subtitle}</SheetDescription>
          )}
        </div>
        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 px-5 py-3">
            {footer}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

/** One part of a drawer: a small heading, then its content. */
export function DrawerSection({
  title,
  actions,
  children,
  testId,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section className="space-y-2" data-testid={testId}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** Label / value pairs in two columns (one on a phone). An empty value is a dash. */
export function DrawerFields({
  items,
  className,
}: {
  items: readonly { label: string; value: ReactNode; wide?: boolean }[];
  className?: string;
}) {
  return (
    <dl className={cn("grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2", className)}>
      {items.map((item) => (
        <div key={item.label} className={cn("min-w-0", item.wide && "sm:col-span-2")}>
          <dt className="text-xs text-slate-500">{item.label}</dt>
          <dd className="mt-0.5 break-words text-sm text-slate-900">
            {item.value === null || item.value === undefined || item.value === "" ? "—" : item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
