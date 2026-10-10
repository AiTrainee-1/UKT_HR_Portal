import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import { BriefBody, BriefStrip } from "./brief";

// Each MD copy of an HR page has an Insights section: a strip that is always visible above the page, and an "Insights"
// tab with the page's analytics. A page supplies them in pages/md/embedded/<page id>/index.tsx (the page ids are the ones
// in md-nav.ts / api/md_portal/pages.py):
//
//   export default function Insights() { ... }      the Insights tab (no layout of its own: the frame is the layout)
//   export function Strip() { ... }                 optional: the strip above the page (default: the page's brief)
//
// A page with no such module gets the generic brief (its analytics module's headline figures and exceptions), so a new
// page shows something useful from the day it exists. Found with import.meta.glob: adding a page means adding a folder.

type InsightsModule = { default: ComponentType; Strip?: ComponentType };

const modules = import.meta.glob<InsightsModule>("../../../pages/md/embedded/*/index.tsx");

export type EmbeddedInsights = {
  Strip: LazyExoticComponent<ComponentType>;
  Body: LazyExoticComponent<ComponentType>;
};

const cache = new Map<string, EmbeddedInsights>();

/** The strip and the Insights tab for a page (made once per page, so a lazy component keeps its loaded state). */
export function insightsFor(pageId: string): EmbeddedInsights {
  const known = cache.get(pageId);
  if (known) return known;

  const load = modules[`../../../pages/md/embedded/${pageId}/index.tsx`];
  const Generic = {
    Strip: () => <BriefStrip page={pageId} />,
    Body: () => <BriefBody page={pageId} />,
  };
  const made: EmbeddedInsights = load
    ? {
        Strip: lazy(async () => {
          const m = await load();
          return { default: m.Strip ?? Generic.Strip };
        }),
        Body: lazy(async () => ({ default: (await load()).default })),
      }
    : {
        Strip: lazy(async () => ({ default: Generic.Strip })),
        Body: lazy(async () => ({ default: Generic.Body })),
      };
  cache.set(pageId, made);
  return made;
}

/** The page ids that have an Insights module of their own (for tests and the docs). */
export const pagesWithOwnInsights = (): string[] =>
  Object.keys(modules).map((p) => p.split("/embedded/")[1].split("/")[0]);
