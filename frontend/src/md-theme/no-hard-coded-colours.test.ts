import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// MD-owned code (the MD portal's components, pages and helpers) takes its colours from the palette: the md-* Tailwind
// utilities (text-md-wine, bg-md-ink/10 ...), the CSS variables (var(--md-wine-700)) and, where CSS cannot reach (a chart's
// stroke), MD_CHART / CHART from lib/md/theme.ts and kit/chartTheme.ts. A hex colour typed into a component is how the old
// blue and gold got everywhere; this keeps them out. White (#fff) is allowed. The number below may only go DOWN.
//
// Files that define the palette are exempt: lib/md/theme.ts, kit/chartTheme.ts. Tests and fixtures are exempt.

const MAX_OFFENDING_LINES = 31; // ratchet: lower it as colours are moved to tokens; the finish line is 0

const src = path.resolve(import.meta.dirname, "..");
const EXEMPT = new Set(["lib/md/theme.ts", "components/md/kit/chartTheme.ts"]);

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name) && !/fixtures/.test(entry.name)) yield full;
  }
}

export function offendingLines(): string[] {
  const found: string[] = [];
  for (const root of ["components/md", "pages/md", "lib/md"]) {
    for (const file of walk(path.join(src, root))) {
      const rel = path.relative(src, file).replace(/\\/g, "/");
      if (EXEMPT.has(rel)) continue;
      fs.readFileSync(file, "utf8")
        .split(/\r?\n/)
        .forEach((line, i) => {
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // a comment may name a colour
          const hexes = line.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
          if (hexes.some((h) => !/^#(fff|ffffff)$/i.test(h)))
            found.push(`${rel}:${i + 1}: ${line.trim().slice(0, 110)}`);
        });
    }
  }
  return found;
}

describe("MD-owned code takes its colours from the palette", () => {
  it(`has no more than ${MAX_OFFENDING_LINES} lines with a hard-coded hex colour (and the goal is none)`, () => {
    const offenders = offendingLines();
    expect(offenders.length, `\n${offenders.join("\n")}`).toBeLessThanOrEqual(MAX_OFFENDING_LINES);
  });
});
