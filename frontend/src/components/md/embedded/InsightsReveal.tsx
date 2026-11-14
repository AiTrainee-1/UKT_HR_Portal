import { createContext, useContext, useEffect, useId, useRef, type ReactNode } from "react";
import { ChevronDown, ChevronUp, Sparkles } from "lucide-react";

/**
 * The "MD insights" strip above an MD copy of an HR page is folded away by default (owner, 2026-11-14): a small card with
 * "Show insights" stands in its place, and the strip, unchanged, opens under it with a "Hide insights" button in its own
 * header. The strip stays mounted while folded (hidden from sight, the keyboard and screen readers), so its figures are
 * ready the moment it opens. Each page starts folded; the choice lasts while the MD stays on that page.
 */

type Toggle = { open: boolean; setOpen: (open: boolean) => void; regionId: string };

const InsightsToggleContext = createContext<Toggle | null>(null);

export function InsightsReveal({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const regionId = useId();
  const showRef = useRef<HTMLButtonElement>(null);
  const regionRef = useRef<HTMLDivElement>(null);
  // focus follows the MD's own click (not the first render): into the opened strip's Hide button, or back to the card
  const toggled = useRef(false);
  useEffect(() => {
    if (!toggled.current) return;
    toggled.current = false;
    if (open) regionRef.current?.querySelector<HTMLButtonElement>("[data-insights-hide]")?.focus();
    else showRef.current?.focus();
  }, [open]);
  const setOpen = (next: boolean) => {
    toggled.current = true;
    onOpenChange(next);
  };

  return (
    <InsightsToggleContext.Provider value={{ open, setOpen, regionId }}>
      {!open && (
        <button
          ref={showRef}
          type="button"
          onClick={() => setOpen(true)}
          aria-expanded={false}
          aria-controls={regionId}
          className="md-shell-insights-card mb-4"
          data-testid="md-insights-show"
        >
          <span className="md-shell-strip-mark" aria-hidden="true">
            <Sparkles size={13} strokeWidth={2.2} />
          </span>
          <span className="min-w-0 flex-1 text-left">
            <span className="md-shell-overline block text-md-wine">MD insights</span>
            <span className="mt-1 block truncate text-xs font-medium text-md-ink-soft">
              Key figures and what stands out on this page
            </span>
          </span>
          <span className="md-shell-insights-pill">
            Show insights
            <ChevronDown size={14} strokeWidth={2.4} aria-hidden="true" />
          </span>
        </button>
      )}
      <div
        ref={regionRef}
        id={regionId}
        role="region"
        aria-label="MD insights"
        className="md-shell-insights-region"
        data-open={open}
        data-testid="md-insights-region"
      >
        <div className="min-h-0 overflow-hidden">{children}</div>
      </div>
    </InsightsToggleContext.Provider>
  );
}

/** "Hide insights" in the strip's own header: drawn only when the strip sits in an InsightsReveal. */
export function HideInsightsButton() {
  const toggle = useContext(InsightsToggleContext);
  if (!toggle) return null;
  return (
    <button
      type="button"
      onClick={() => toggle.setOpen(false)}
      aria-expanded={toggle.open}
      aria-controls={toggle.regionId}
      aria-label="Hide insights"
      title="Hide insights"
      data-insights-hide=""
      data-testid="md-insights-hide"
      className="md-btn md-btn-ghost md-btn-sm md-shell-insights-hide"
    >
      <ChevronUp size={14} strokeWidth={2.4} aria-hidden="true" />
      <span className="hidden sm:inline">Hide insights</span>
    </button>
  );
}
