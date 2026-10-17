import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { useLocation, useSearch } from "wouter";
import { cn } from "@/lib/utils";

// The second level of tabs of Compensation: the sections of a subtab, one at a time. They look smaller and lighter than the
// first level's pills (a thin underlined row, not a filled capsule) so the two levels read as parent and child. The nested
// subtab is a path segment like the first level, so every section has an address of its own; the filters in the query string
// go along with a switch.

export type NestedTabItem = {
  value: string;
  label: string;
  /** A count worth showing on the tab ("Waiting for HR (73)"); nothing when the number is not known yet. */
  count?: number;
};

/**
 * The strip of nested subtabs and, under it, the panel of the chosen one: only that panel is rendered, so a section that is
 * not on screen asks the server for nothing. A tablist with a roving tabindex: Left / Right / Home / End move between the
 * tabs (and open the one they land on), Tab leaves the strip for the panel.
 */
export function NestedTabs({
  base,
  items,
  value,
  testId,
  label,
  children,
}: {
  /** The address of the subtab this strip belongs to (`/hr/compensation/ot-detection/type-2`). */
  base: string;
  items: NestedTabItem[];
  value: string;
  /** `leave-holiday-nested`: the strip is `<testId>`, its tabs `<testId>-<value>`, the panel `<testId>-panel`. */
  testId: string;
  /** What the sections are sections of, read out by a screen reader ("Sections of Sunday and holiday work"). */
  label: string;
  /** The chosen section. */
  children: ReactNode;
}) {
  const [, navigate] = useLocation();
  const search = useSearch();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const strip = useRef<HTMLDivElement>(null);
  const active = Math.max(
    0,
    items.findIndex((item) => item.value === value),
  );

  // on a phone the strip scrolls inside its own box: keep the open tab in view (the page itself is never scrolled)
  useEffect(() => {
    const box = strip.current;
    const tab = buttons.current[active];
    if (!box || !tab || box.scrollWidth <= box.clientWidth) return;
    box.scrollLeft = tab.offsetLeft - (box.clientWidth - tab.offsetWidth) / 2;
  }, [active, items.length]);

  const open = (next: string) => navigate(`${base}/${next}${search ? `?${search}` : ""}`);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let to = index;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") to = (index + 1) % items.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") to = (index - 1 + items.length) % items.length;
    else if (event.key === "Home") to = 0;
    else if (event.key === "End") to = items.length - 1;
    else return;
    event.preventDefault();
    buttons.current[to]?.focus();
    if (items[to].value !== value) open(items[to].value);
  };

  return (
    <div className="space-y-4" data-testid={testId}>
      <div ref={strip} className="max-w-full overflow-x-auto border-b border-slate-200" data-testid={`${testId}-strip`}>
        <div role="tablist" aria-label={label} className="flex w-max min-w-full gap-1">
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
                onClick={() => open(item.value)}
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
                {item.count !== undefined && (
                  <>
                    {" "}
                    <span className={cn("font-semibold", on ? "text-indigo-500" : "text-slate-400")}>
                      ({item.count})
                    </span>
                  </>
                )}
              </button>
            );
          })}
        </div>
      </div>
      <div
        role="tabpanel"
        id={`${testId}-panel`}
        aria-labelledby={`${testId}-tab-${items[active]?.value}`}
        className="space-y-4"
        data-testid={`${testId}-panel`}
      >
        {children}
      </div>
    </div>
  );
}
