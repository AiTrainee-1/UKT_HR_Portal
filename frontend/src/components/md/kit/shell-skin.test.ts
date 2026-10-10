import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The shell's look is split in two on purpose: layout is Tailwind in the components, and everything that needs a gradient, a
// blur or a tint taken from the palette is a class in md-theme/areas/shell.css. A class typed wrongly in a component, or a
// leftover rule nobody uses, would not fail anything else: it would just quietly show nothing. This keeps the two in step,
// and keeps the shell's files away from the colours the product owner retired.

const src = path.resolve(import.meta.dirname, "../../..");
const read = (file: string) => fs.readFileSync(path.join(src, file), "utf8");
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) yield full;
  }
}

const css = strip(read("md-theme/areas/shell.css"));
const defined = new Set([...css.matchAll(/\.(md-shell-[a-z0-9-]+)/g)].map((m) => m[1]));

/** The files of the shell: the frame, the sidebar, the kit and the embedded frame with its strip. */
const SHELL_FILES = [
  "components/md/MdLayout.tsx",
  "components/md/MdSidebar.tsx",
  "components/md/PlaceholderPage.tsx",
  ...fs
    .readdirSync(path.join(src, "components/md/kit"))
    .filter((f) => f.endsWith(".tsx") && !f.includes(".test."))
    .map((f) => `components/md/kit/${f}`),
  "components/md/embedded/MdEmbeddedFrame.tsx",
  "components/md/embedded/brief.tsx",
];

const CLASS = /md-shell-[a-z0-9-]+/g;
const usedByShell = new Set(SHELL_FILES.flatMap((f) => read(f).match(CLASS) ?? []));
const usedAnywhere = new Set(
  ["components/md", "pages/md"].flatMap((dir) =>
    [...walk(path.join(src, dir))].flatMap((f) => fs.readFileSync(f, "utf8").match(CLASS) ?? []),
  ),
);

describe("the shell's skin", () => {
  it("defines every md-shell-* class the shell's files use", () => {
    expect([...usedByShell].filter((c) => !defined.has(c))).toEqual([]);
  });

  it("has no md-shell-* rule that no component uses", () => {
    expect([...defined].filter((c) => !usedAnywhere.has(c))).toEqual([]);
  });

  it("keeps the shell's files free of the old blue, gold and Tailwind greys", () => {
    const old =
      /(?:text|bg|border|ring|from|to|via|fill|stroke)-(?:gray|slate|zinc|neutral|stone|blue|sky|indigo|cyan|teal|emerald|green|amber|yellow|orange|red|purple|violet)-\d{2,3}/;
    const offenders = SHELL_FILES.flatMap((f) =>
      read(f)
        .split(/\r?\n/)
        .map((line, i) => ({ f, i: i + 1, line }))
        .filter(({ line }) => old.test(line) || /#e0a83a|#f6d27a|#006496/i.test(line))
        .map(({ f: file, i, line }) => `${file}:${i}: ${line.trim()}`),
    );
    expect(offenders).toEqual([]);
  });

  it("gives every collapsed-rail and drawer control a name for assistive technology", () => {
    const sidebar = read("components/md/MdSidebar.tsx");
    for (const label of ["Expand sidebar", "Collapse sidebar", "Close menu", "AI assistant", "Sign out", "HR portal"]) {
      expect(sidebar, label).toContain(`"${label}"`);
    }
    expect(read("components/md/MdLayout.tsx")).toContain('aria-label="Open menu"');
  });
});
