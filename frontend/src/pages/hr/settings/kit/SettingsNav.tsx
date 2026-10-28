import { useEffect } from "react";
import { cn } from "@/lib/utils";
import { SETTINGS_GROUPS, type SettingsTabDef } from "./catalog";

/**
 * The page's navigation: the tabs in groups, down the left on a wide screen and as a row of chips on a phone. It is a real
 * tablist (each item is a role="tab" named exactly by its label), so keyboard users and the end-to-end tests reach a tab
 * by its name. Arrow keys move between tabs.
 */
export function SettingsNav({
  tabs,
  value,
  onChange,
}: {
  tabs: SettingsTabDef[];
  value: string;
  onChange: (id: string) => void;
}) {
  const ordered = tabs;

  // On a phone the tabs are one row you scroll sideways: keep the open one in view (a link or the search may open a tab
  // that is off the edge).
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia("(max-width: 1023px)").matches) return;
    document
      .getElementById(`settings-tab-${value}`)
      ?.scrollIntoView?.({ block: "nearest", inline: "center", behavior: "smooth" });
  }, [value]);

  const move = (from: number, step: number) => {
    const next = ordered[(from + step + ordered.length) % ordered.length];
    if (next) {
      onChange(next.id);
      requestAnimationFrame(() => document.getElementById(`settings-tab-${next.id}`)?.focus());
    }
  };

  return (
    <nav
      aria-label="Settings sections"
      className="settings-glass settings-rail max-lg:sticky max-lg:top-2 max-lg:z-20 lg:sticky lg:top-4 lg:max-h-[calc(100dvh-3.5rem)] lg:self-start lg:overflow-y-auto lg:overscroll-contain lg:[scrollbar-width:thin]"
    >
      <div
        role="tablist"
        aria-orientation="vertical"
        className="flex gap-2 overflow-x-auto scrollbar-hide lg:block lg:space-y-4 lg:overflow-visible"
        data-testid="settings-nav"
      >
        {SETTINGS_GROUPS.map((group) => {
          const items = ordered.filter((t) => t.group === group.id);
          if (items.length === 0) return null;
          return (
            <div key={group.id} role="presentation" className="flex shrink-0 items-center gap-1.5 lg:block">
              <p
                className="mb-1 hidden px-2 text-[11px] font-medium uppercase tracking-wider text-slate-400 lg:block"
                title={group.hint}
              >
                {group.label}
              </p>
              <div role="presentation" className="flex gap-1.5 lg:flex-col">
                {items.map((t) => {
                  const active = t.id === value;
                  const Icon = t.icon;
                  return (
                    <button
                      key={t.id}
                      id={`settings-tab-${t.id}`}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      aria-controls="settings-panel"
                      tabIndex={active ? 0 : -1}
                      title={t.purpose}
                      onClick={() => onChange(t.id)}
                      onKeyDown={(e) => {
                        const i = ordered.findIndex((x) => x.id === t.id);
                        if (e.key === "ArrowDown" || e.key === "ArrowRight") {
                          e.preventDefault();
                          move(i, 1);
                        } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
                          e.preventDefault();
                          move(i, -1);
                        }
                      }}
                      className={cn(
                        "settings-nav-item flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-lg border border-transparent px-3 py-2 text-left text-[13px] font-medium lg:w-full",
                        !active && "bg-slate-50 lg:bg-transparent",
                      )}
                    >
                      <Icon size={15} className={active ? "text-[#006496]" : "text-slate-400"} />
                      <span>{t.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </nav>
  );
}
