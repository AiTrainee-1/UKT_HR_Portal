import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The assistant's look is split in two on purpose: the classes are in md-theme/areas/assistant.css, and the @keyframes they
// animate with are in a <style> in AssistantHost.tsx (md-theme.test.ts does not accept percentage selectors in an area file).
// A class typed wrongly in a component, or a leftover rule nobody uses, or an animation whose keyframes went missing, would
// not fail anything else: it would just quietly show nothing. This keeps the three in step.

const here = import.meta.dirname;
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const css = strip(fs.readFileSync(path.resolve(here, "../../../md-theme/areas/assistant.css"), "utf8"));
const host = fs.readFileSync(path.join(here, "AssistantHost.tsx"), "utf8");

const components = fs
  .readdirSync(here)
  .filter((f) => f.endsWith(".tsx") && !f.includes(".test."))
  .map((f) => fs.readFileSync(path.join(here, f), "utf8").replace(/@keyframes\s+md-assistant-[a-z-]+/g, ""))
  .join("\n");

const CLASS = /md-assistant-[a-z0-9-]+/g;
const used = new Set(components.match(CLASS) ?? []);
const defined = new Set([...css.matchAll(/\.(md-assistant-[a-z0-9-]+)/g)].map((m) => m[1]));

describe("the assistant's skin", () => {
  it("defines every md-assistant-* class the components use", () => {
    expect([...used].filter((c) => !defined.has(c))).toEqual([]);
  });

  it("has no md-assistant-* rule that no component uses", () => {
    expect([...defined].filter((c) => !used.has(c))).toEqual([]);
  });

  it("has the keyframes every animation in the stylesheet names", () => {
    const named = [...css.matchAll(/animation:\s*(md-assistant-[a-z-]+)/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((n) => !host.includes(`@keyframes ${n}`))).toEqual([]);
  });

  it("keeps every colour in the assistant's files a palette variable (no hex)", () => {
    expect(host.replace(/\/\/.*$/gm, "").match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
  });
});
