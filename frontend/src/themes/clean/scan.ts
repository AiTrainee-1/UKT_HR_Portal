// A small reader for the theme's CSS, used by clean-theme.test.ts: it splits a stylesheet into its rules and reads their
// selectors and declarations, so the guard tests can check every rule instead of grepping text. The theme's CSS is plain
// (no nesting), which keeps this simple: a block is either an at-rule holding rules (@media, @supports, @keyframes) or a
// style rule holding declarations.

import fs from "node:fs";
import path from "node:path";

export const CLEAN_DIR = import.meta.dirname;

/** What every selector in the theme must start with: only when the theme is chosen, never inside the MD portal. */
export const SCOPE = 'html[data-theme="clean"]:not([data-md-theme])';

export type Block = {
  /** The text before the `{`: a selector list, or an at-rule such as `@media (max-width: 640px)`. */
  prelude: string;
  /** The declarations of a style rule (empty for an at-rule that only holds rules). */
  body: string;
  /** The at-rules this block sits inside, outermost first. */
  inside: string[];
};

export const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Every block of a stylesheet, in order of its closing brace. `@import` / `@charset` statements come back with no body. */
export function parseBlocks(source: string): Block[] {
  const css = stripComments(source);
  const out: Block[] = [];
  const stack: { prelude: string; body: string }[] = [];
  let buf = "";
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '"' || ch === "'") {
      // a string (an attribute selector's value, a url, a font name): copied whole, its braces and semicolons mean nothing
      buf += ch;
      i++;
      while (i < css.length && css[i] !== ch) {
        if (css[i] === "\\") buf += css[i++];
        buf += css[i++];
      }
      buf += ch;
      continue;
    }
    if (ch === "{") {
      stack.push({ prelude: buf.trim(), body: "" });
      buf = "";
    } else if (ch === "}") {
      const top = stack.pop();
      if (!top) throw new Error("unbalanced } in the stylesheet");
      top.body += buf;
      buf = "";
      out.push({ prelude: top.prelude, body: top.body.trim(), inside: stack.map((s) => s.prelude) });
    } else if (ch === ";" && stack.length === 0) {
      out.push({ prelude: buf.trim(), body: "", inside: [] });
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (stack.length) throw new Error("unbalanced { in the stylesheet");
  return out;
}

/** The style rules (those with declarations to apply to elements): not at-rules, not the steps of a @keyframes. */
export function styleRules(source: string): Block[] {
  return parseBlocks(source).filter(
    (b) => !b.prelude.startsWith("@") && !b.inside.some((a) => /^@(keyframes|font-face)\b/.test(a)),
  );
}

/** A selector list split at the commas that are not inside (...) or [...]. */
export function splitSelectors(prelude: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let cur = "";
  for (const ch of prelude) {
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/** Every .css file of the theme (areas/ included), as a path relative to the theme folder with forward slashes. */
export function themeFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".css")) found.push(path.relative(CLEAN_DIR, full).replace(/\\/g, "/"));
    }
  };
  walk(CLEAN_DIR);
  return found.sort();
}

export const readThemeFile = (rel: string) => fs.readFileSync(path.join(CLEAN_DIR, rel), "utf8");

// A colour VALUE: a hex, or a colour function with numbers in it (hsl(var(--primary)) is the reading of a token, not a value).
const COLOUR_VALUE = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(\s*[\d.]/;
const NAMED_COLOUR =
  /(?:^|[\s,(:])(white|black|red|green|blue|yellow|orange|purple|pink|gray|grey|silver|navy|teal|maroon|gold)(?=[\s,);]|$)/i;

/** The declarations of a stylesheet that write a colour instead of reading a token (selectors are not declarations). */
export function colourDeclarations(source: string): string[] {
  const found: string[] = [];
  for (const rule of styleRules(source)) {
    for (const decl of rule.body.split(";")) {
      if (!decl.includes(":")) continue;
      const value = decl.slice(decl.indexOf(":") + 1);
      if (COLOUR_VALUE.test(value) || NAMED_COLOUR.test(value))
        found.push(`${rule.prelude.slice(0, 70)} { ${decl.trim()} }`);
    }
  }
  return found;
}

/** The lines of a stylesheet that declare !important (a comment that only talks about the keyword is not one). */
export const importantDeclarations = (source: string): string[] =>
  source.split(/\r?\n/).filter((line) => /!important\s*;/.test(line));
