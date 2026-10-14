import { useMemo, useState } from "react";
import { CornerDownLeft, Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { searchSettings, type SettingMeta, type SettingsTabDef } from "./catalog";

/**
 * "Find a setting": type a word ("grace", "pf", "logo") and pick one of the settings that mention it. Choosing one opens its
 * tab and scrolls to it. Settings in a tab the signed-in role cannot see are not offered (the caller passes only visible tabs).
 */
export function SettingsSearch({
  metas,
  tabs,
  onPick,
}: {
  metas: SettingMeta[];
  tabs: SettingsTabDef[];
  onPick: (meta: SettingMeta) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const tabLabel = useMemo(() => new Map(tabs.map((t) => [t.id, t.label])), [tabs]);
  const visible = useMemo(() => {
    const ids = new Set(tabs.map((t) => t.id));
    return metas.filter((m) => ids.has(m.tab));
  }, [metas, tabs]);
  const results = useMemo(() => searchSettings(visible, tabs, query), [visible, tabs, query]);

  const pick = (meta: SettingMeta) => {
    setQuery("");
    setOpen(false);
    onPick(meta);
  };

  return (
    <div className="relative w-full max-w-md" data-testid="settings-search">
      <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
      <Input
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, Math.max(results.length - 1, 0)));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter" && results[active]) {
            e.preventDefault();
            pick(results[active]);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        placeholder="Find a setting: grace period, PF rate, logo…"
        aria-label="Find a setting"
        role="combobox"
        aria-expanded={open && query.trim() !== ""}
        aria-controls="settings-search-results"
        className="h-10 rounded-lg pl-9 pr-9 text-sm"
      />
      {query && (
        <button
          type="button"
          aria-label="Clear search"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setQuery("")}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-full p-1 text-gray-400 hover:bg-gray-100"
        >
          <X size={13} />
        </button>
      )}
      {open && query.trim() !== "" && (
        <div
          id="settings-search-results"
          role="listbox"
          className="settings-glass absolute left-0 right-0 top-full z-30 mt-1.5 max-h-80 overflow-y-auto rounded-lg p-1.5 shadow-lg"
          data-testid="settings-search-results"
        >
          {results.length === 0 ? (
            <p className="px-3 py-3 text-sm text-gray-500">No setting mentions "{query.trim()}".</p>
          ) : (
            results.map((m, i) => (
              <button
                key={`${m.tab}/${m.id}`}
                type="button"
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(m)}
                onMouseEnter={() => setActive(i)}
                className={`flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left ${
                  i === active ? "bg-blue-50" : "hover:bg-gray-50"
                }`}
                data-testid={`settings-search-hit-${m.tab}-${m.id}`}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-semibold text-slate-900">{m.title}</p>
                  <p className="truncate text-[11px] text-gray-500">
                    {tabLabel.get(m.tab)} · {m.section}
                  </p>
                </div>
                {i === active && <CornerDownLeft size={13} className="mt-1 shrink-0 text-blue-500" />}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
