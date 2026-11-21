import type { CSSProperties } from "react";
import { MD_PALETTE } from "@/lib/md/theme";

// What an MD page shows for the moment its shell (and the MD skin's stylesheet) is still on the way: the page's light
// background and the outline of the sidebar and a card, in inline styles and the app's own Tailwind utilities, because
// the MD skin is exactly what has not arrived yet. Usually it is never seen (the shell is fetched ahead, see loader.ts).

const page: CSSProperties = {
  background: `linear-gradient(135deg, ${MD_PALETTE.alabaster} 0%, ${MD_PALETTE.vanilla} 56%, ${MD_PALETTE.sand} 100%)`,
  fontFamily: "'Hanken Grotesk', 'Inter', sans-serif",
};
const glass: CSSProperties = {
  background: "rgba(255, 255, 255, 0.55)",
  border: "1px solid rgba(255, 255, 255, 0.75)",
  boxShadow: "0 12px 36px -10px rgba(40, 43, 74, 0.2)",
};
const bar = (width: string, height = 12): CSSProperties => ({
  width,
  height,
  borderRadius: 9999,
  background: "rgba(40, 43, 74, 0.08)",
});

export default function ShellFallback() {
  return (
    <div className="flex h-screen" style={page} data-testid="md-loading-shell" aria-busy="true">
      <div className="m-3 hidden w-60 shrink-0 flex-col gap-3 rounded-2xl p-4 lg:flex" style={glass} aria-hidden>
        <div style={bar("60%", 16)} />
        <div style={bar("85%", 34)} />
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} style={bar(`${70 - i * 5}%`)} />
        ))}
      </div>
      <div className="min-w-0 flex-1 p-3 sm:p-4 lg:p-6" aria-hidden>
        <div className="mx-auto max-w-[1600px] space-y-4 motion-safe:animate-pulse">
          <div className="rounded-3xl p-6" style={{ ...glass, minHeight: 190 }}>
            <div style={bar("28%")} />
            <div className="mt-4" style={bar("55%", 30)} />
            <div className="mt-6" style={bar("100%", 44)} />
          </div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="rounded-2xl" style={{ ...glass, height: 96 }} />
            ))}
          </div>
        </div>
      </div>
      <span className="sr-only">Loading the MD portal</span>
    </div>
  );
}
