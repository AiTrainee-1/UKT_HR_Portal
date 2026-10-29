import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import type { Accent } from "./accent";
import { SECTIONS } from "./logic";

/**
 * The page's own navigation: it sticks to the top while the long page scrolls, jumps to a section when one is
 * pressed and marks the section being read. The Issues entry carries the issue count, so what is worth a look is
 * visible from anywhere on the page.
 */
export function SectionNav({
  active,
  onJump,
  accent,
  issues,
  criticalIssues,
  who,
}: {
  active: string;
  onJump: (sectionId: string) => void;
  accent: Accent;
  issues: number;
  criticalIssues: number;
  /** "Meena Subramanian · UKT-0142": who the page is about, kept in view while scrolling. */
  who: string;
}) {
  const barRef = useRef<HTMLDivElement>(null);

  // On a phone the entries scroll sideways: keep the active one in view without moving the page.
  useEffect(() => {
    const bar = barRef.current;
    const button = bar?.querySelector<HTMLElement>('[aria-current="location"]');
    if (!bar || !button || bar.scrollWidth <= bar.clientWidth) return;
    bar.scrollLeft = button.offsetLeft - (bar.clientWidth - button.offsetWidth) / 2;
  }, [active]);

  // The shell's scroll area has p-4 / lg:p-6 around its content, and a sticky element stops at the content's edge, not
  // the area's: the negative top (and margins) cancel that padding so the bar sits flush, full width, at the very top.
  return (
    <div
      className="sticky -top-4 z-30 -mx-4 border-b border-slate-200/70 bg-white/85 px-4 py-2 backdrop-blur-md lg:-top-6 lg:-mx-6 lg:px-6 print:hidden"
      data-testid="pd-nav-bar"
    >
      <div className="flex items-center gap-3">
        <nav
          ref={barRef}
          aria-label="Payroll sections"
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          data-testid="pd-nav"
        >
          {SECTIONS.map((section) => {
            const isActive = active === section.id;
            return (
              <button
                key={section.id}
                type="button"
                aria-current={isActive ? "location" : undefined}
                onClick={() => onJump(section.id)}
                data-testid={`pd-nav-${section.id}`}
                className={cn(
                  "inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-xs font-bold transition-colors",
                  isActive ? accent.solid : "text-slate-600 hover:bg-slate-100",
                )}
              >
                {section.label}
                {section.id === "issues" && issues > 0 && (
                  <span
                    className={cn(
                      "min-w-[18px] rounded-full px-1.5 text-center text-[10px] font-black leading-[18px]",
                      criticalIssues > 0 ? "bg-red-500 text-white" : "bg-amber-400 text-amber-950",
                    )}
                    data-testid="pd-nav-issues-count"
                  >
                    {issues}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
        <span className="hidden max-w-[16rem] shrink-0 truncate text-xs font-semibold text-slate-500 lg:block">
          {who}
        </span>
      </div>
    </div>
  );
}
