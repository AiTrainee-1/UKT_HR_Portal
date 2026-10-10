import { useLayoutEffect, useState } from "react";
import { adoptHeaderRow, type HeaderAdoption } from "./headerRow";

export type AdoptedHeader = { adoption: HeaderAdoption; title: string; subtitle: string };

/**
 * Finds the title row of the HR page rendered inside `root` and makes room in it (headerRow.ts says how), or returns
 * null while the page has no title row it can use (still loading, or laid out in a way the frame does not know): the
 * frame then draws a title row of its own. Follows the page when it re-renders its header, and gives the page's header
 * back when the frame goes away.
 */
export function useHeaderAdoption(root: HTMLElement | null, grid = false): AdoptedHeader | null {
  const [adopted, setAdopted] = useState<AdoptedHeader | null>(null);

  useLayoutEffect(() => {
    if (!root) return;
    let current: HeaderAdoption | null = null;
    let shown = { title: "", subtitle: "" };
    // a heading for which no usable title row was found: not tried again until the page shows another one
    let gaveUp: Element | null = null;

    const publish = () => {
      if (!current) {
        setAdopted(null);
        return;
      }
      shown = current.read();
      setAdopted({ adoption: current, ...shown });
    };

    const sync = () => {
      if (current?.intact()) {
        current.tidy();
        const text = current.read();
        if (text.title !== shown.title || text.subtitle !== shown.subtitle) publish();
        return;
      }
      current?.release();
      current = null;
      const heading = root.querySelector("h1, h2");
      if (heading && heading !== gaveUp) {
        current = adoptHeaderRow(root, { grid });
        if (!current) gaveUp = heading;
      }
      publish();
    };

    sync();
    // every change the page makes inside itself; the work is a few property reads unless the header itself moved
    const observer = new MutationObserver(sync);
    observer.observe(root, { childList: true, subtree: true });
    // the room the page has changes with the window, the sidebar and the assistant panel
    const resized = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => current?.layout());
    resized?.observe(root);
    return () => {
      observer.disconnect();
      resized?.disconnect();
      current?.release();
      current = null;
      setAdopted(null);
    };
  }, [root, grid]);

  return adopted;
}
