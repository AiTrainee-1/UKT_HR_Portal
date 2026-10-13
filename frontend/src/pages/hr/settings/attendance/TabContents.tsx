/** A row of jump links to the sections of a long tab (scrolls only: the page address is left alone). */
export function TabContents({ items }: { items: { id: string; label: string }[] }) {
  return (
    <nav aria-label="On this tab" className="flex flex-wrap items-center gap-1.5" data-view-safe>
      <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400">On this tab</span>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => document.getElementById(item.id)?.scrollIntoView({ behavior: "smooth", block: "start" })}
          className="settings-chip rounded-full px-2.5 py-1 text-[12px] font-semibold text-slate-700 hover:text-blue-700"
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}
