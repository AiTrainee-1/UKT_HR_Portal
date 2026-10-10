// An HR page draws its own title row (the title, what the page is for, its buttons). The MD portal's copy of the page is
// shown with the same title row as every other MD page (kit/MdHeaderParts): the Live chip right after the title, the
// Operations / Insights switch beside it, the Updated / Refresh stack at the far right. The HR page files are not touched
// (the MD pages are the only thing that changes), so the frame finds the page's title row in the DOM and slots those pieces
// into it:
//
//   [ Title (live) ] [mid: the switch] ............. [ the page's own buttons ]  | end: Updated
//   [ what the page is for ]                                                      |      Refresh
//   [below: the page's insights strip]
//
// The stack is pinned to the row's top-right corner with room kept for it, so it sits in the same place on every page
// however the page's own buttons wrap. On a narrow screen it goes back into the flow of the row instead.
//
// This file is the DOM half (no React): it finds the row, makes the slots, keeps them in place while the page re-renders,
// and puts everything back on release. useHeaderAdoption.ts is the React half.

export type HeaderAdoption = {
  /** The page's title row. */
  row: HTMLElement;
  /** Inside the page's heading, after its text: the Live chip (inline). */
  live: HTMLElement;
  /** Right after the title block: the Operations / Insights switch (the slot draws nothing itself: `display: contents`). */
  mid: HTMLElement;
  /** The Updated / Refresh stack: top-right of the row (or last in it, on a narrow screen). */
  end: HTMLElement;
  /** Right under the title row (and its subtitle): the insights strip. */
  below: HTMLElement;
  /** The page's own title and the line under it, as they are now. */
  read(): { title: string; subtitle: string };
  /** Is everything still where it was put? */
  intact(): boolean;
  /** Put back what the page's re-render moved and hide any new Refresh button of the page's own. */
  tidy(): void;
  /** Pin the stack in the corner when there is room, or put it in the row's flow when there is not. */
  layout(): void;
  /** Take the slots out and give the page's header back as it was. */
  release(): void;
};

type Found = { heading: HTMLElement; titleBlock: HTMLElement; row: HTMLElement; subtitle: HTMLElement | null };

const isFlex = (el: Element) => /flex/.test(getComputedStyle(el).display);
const spreadsOut = (el: Element) => getComputedStyle(el).justifyContent === "space-between";

/** Room the stack needs at the right of the row (its widest text plus the hairline and the gap before it). */
const STACK_ROOM = "9.75rem";
/** Narrower than this and the stack stays in the flow of the row (a phone, or a laptop with the assistant open). */
const WIDE_PX = 720;

/** The page's first heading is its title; the row is the nearest flex container around it that spreads its items out
 *  (the title on the left, the buttons on the right), or else the nearest flex container. */
export function findHeader(root: HTMLElement): Found | null {
  const heading = root.querySelector<HTMLElement>("h1, h2");
  if (!heading) return null;

  let block: HTMLElement = heading;
  let firstFlex: { titleBlock: HTMLElement; row: HTMLElement } | null = null;
  let spread: { titleBlock: HTMLElement; row: HTMLElement } | null = null;
  for (let depth = 0; depth < 5; depth++) {
    const parent = block.parentElement;
    if (!parent || parent === root) break;
    if (isFlex(parent)) {
      firstFlex ??= { titleBlock: block, row: parent };
      if (spreadsOut(parent)) {
        spread = { titleBlock: block, row: parent };
        break;
      }
    }
    block = parent;
  }
  const hit = spread ?? firstFlex;
  if (!hit) return null;

  // the line under the title: inside the title block, or (when the title block is just the heading) right after the row
  const inside = hit.titleBlock !== heading ? hit.titleBlock.querySelector<HTMLElement>("p") : null;
  const after = hit.row.nextElementSibling;
  const subtitle = inside ?? (after && after.tagName === "P" ? (after as HTMLElement) : null);
  return { heading, titleBlock: hit.titleBlock, row: hit.row, subtitle };
}

/** The heading's own words (not an inline badge such as "3 pending"). */
const ownText = (el: HTMLElement) =>
  Array.from(el.childNodes)
    .filter((n) => n.nodeType === Node.TEXT_NODE)
    .map((n) => n.textContent ?? "")
    .join("")
    .replace(/\s+/g, " ")
    .trim() || (el.textContent ?? "").replace(/\s+/g, " ").trim();

/** One of the page's own Refresh buttons (the stack replaces them); not the stack's own. */
const isOwnRefresh = (button: HTMLElement) =>
  !button.closest("[data-md-slot]") &&
  (button.getAttribute("data-testid") === "button-page-refresh" || (button.textContent ?? "").trim() === "Refresh");

export type AdoptOptions = {
  /** Lay the title row out as a grid (md-theme/areas/shell.css, [data-md-grid]): the title and the subtitle on the left, the
   *  Operations / Insights switch and the Updated / Refresh stack always in the same place on the right, and below them the
   *  title block's own extra (a sub-tab strip, a pipeline line) on the left with the page's buttons on the right. Used by
   *  the pages whose own title row is tall (md-portal.md 11.6); the others keep the flowing row. */
  grid?: boolean;
};

export function adoptHeaderRow(root: HTMLElement, options: AdoptOptions = {}): HeaderAdoption | null {
  const found = findHeader(root);
  if (!found) return null;
  const { heading, titleBlock, row, subtitle } = found;
  const doc = root.ownerDocument;

  const slot = (name: string, display: string, tag = "div") => {
    const el = doc.createElement(tag);
    el.setAttribute("data-md-slot", name);
    el.style.display = display;
    return el;
  };
  const live = slot("live", "inline-flex", "span");
  live.style.verticalAlign = "middle";
  live.style.marginLeft = "0.625rem";
  live.style.fontSize = "0";
  const mid = slot("mid", "contents");
  const end = slot("end", "contents");
  const below = slot("below", "block");

  // The row may not wrap on its own (the page was laid out for a title and a few buttons): with the switch added it must
  // be allowed to, or the buttons are squeezed. Remember what was there to give it back.
  const was = {
    flexWrap: row.style.flexWrap,
    rowGap: row.style.rowGap,
    columnGap: row.style.columnGap,
    position: row.style.position,
    paddingRight: row.style.paddingRight,
  };
  const computed = getComputedStyle(row);
  row.style.flexWrap = "wrap";
  row.style.rowGap = "0.75rem";
  if (computed.columnGap === "normal" || computed.columnGap === "0px") row.style.columnGap = "0.75rem";

  heading.setAttribute("data-md-title", "");
  subtitle?.setAttribute("data-md-subtitle", "");
  row.setAttribute("data-md-header-row", "");
  if (titleBlock !== heading) titleBlock.setAttribute("data-md-titleblock", "");
  if (options.grid) row.setAttribute("data-md-aligned", "");

  // A page that centres itself in a padded, width-limited container of its own (the Report Log) would start its title
  // further in and lower than every other page, which sit straight in the MD's content area: take that padding off.
  const flattened: { el: HTMLElement; padding: string }[] = [];
  for (let a = row.parentElement; a && a !== root; a = a.parentElement) {
    const cs = getComputedStyle(a);
    if (cs.maxWidth !== "none" && (parseFloat(cs.paddingLeft) > 0 || parseFloat(cs.paddingTop) > 0)) {
      flattened.push({ el: a, padding: a.style.padding });
      a.style.padding = "0";
    }
  }

  const hidden = new Set<HTMLElement>();
  const hideOwnRefresh = () => {
    for (const button of Array.from(row.querySelectorAll<HTMLElement>("button"))) {
      if (!hidden.has(button) && isOwnRefresh(button)) {
        button.style.display = "none";
        hidden.add(button);
      }
    }
  };

  // the page's own buttons go to the right of the row, also when they wrap onto a line of their own
  let pushed: HTMLElement | null = null;
  let pushedWas = "";
  const pushActions = () => {
    const next = mid.nextElementSibling as HTMLElement | null;
    const target = next && next !== end && next !== below ? next : null;
    if (target === pushed) return;
    if (pushed) pushed.style.marginLeft = pushedWas;
    pushed = target;
    pushedWas = target?.style.marginLeft ?? "";
    if (target) target.style.marginLeft = "auto";
  };

  // whatever else the page puts in its title row (its buttons) is marked, so the grid layout can place it
  const markedActions = new Set<Element>();
  const markActions = () => {
    for (const child of Array.from(row.children)) {
      const own = child === titleBlock || child === mid || child === end;
      if (!own && !child.hasAttribute("data-md-actions")) {
        child.setAttribute("data-md-actions", "");
        markedActions.add(child);
      } else if (own && child.hasAttribute("data-md-actions")) {
        child.removeAttribute("data-md-actions");
        markedActions.delete(child);
      }
    }
  };

  // below goes after the subtitle when that is a sibling of the row (a page whose title row holds only the heading)
  const anchor = () => (subtitle && subtitle.parentElement === row.parentElement ? subtitle : row);
  const place = () => {
    if (heading.lastElementChild !== live) heading.append(live);
    if (titleBlock.nextElementSibling !== mid) titleBlock.after(mid);
    if (row.lastElementChild !== end) row.append(end);
    const a = anchor();
    if (a.nextElementSibling !== below) a.after(below);
    // a title row whose subtitle sits outside it is not spaced by the page's own `space-y`
    below.style.marginTop = a === row ? "" : "1.25rem";
    pushActions();
    markActions();
  };

  const layout = () => {
    const wide = root.clientWidth >= WIDE_PX;
    // wide: either the grid (the stack is a cell of it) or the flowing row with the stack pinned in the corner;
    // narrow: the flowing row, the stack last in it
    // (a title block that holds the heading deeper down than its first level cannot be dissolved into the grid)
    const asGrid = wide && options.grid === true && (titleBlock === heading || heading.parentElement === titleBlock);
    const pinned = wide && !asGrid;
    if (asGrid) row.setAttribute("data-md-grid", "");
    else row.removeAttribute("data-md-grid");
    row.style.position = pinned ? "relative" : was.position;
    row.style.paddingRight = pinned ? STACK_ROOM : was.paddingRight;
    end.style.display = pinned ? "flex" : "contents";
    end.style.position = pinned ? "absolute" : "";
    end.style.top = pinned ? "0" : "";
    end.style.right = pinned ? "0" : "";
    end.style.minHeight = pinned ? "2.75rem" : "";
    end.style.alignItems = pinned ? "center" : "";
  };

  place();
  hideOwnRefresh();
  layout();

  return {
    row,
    live,
    mid,
    end,
    below,
    read: () => ({ title: ownText(heading), subtitle: subtitle ? (subtitle.textContent ?? "").trim() : "" }),
    intact: () =>
      row.isConnected &&
      row.contains(heading) &&
      live.parentElement === heading &&
      mid.parentElement === row &&
      end.parentElement === row &&
      below.isConnected,
    tidy: () => {
      place();
      hideOwnRefresh();
    },
    layout,
    release: () => {
      live.remove();
      mid.remove();
      end.remove();
      below.remove();
      row.style.flexWrap = was.flexWrap;
      row.style.rowGap = was.rowGap;
      row.style.columnGap = was.columnGap;
      row.style.position = was.position;
      row.style.paddingRight = was.paddingRight;
      for (const { el, padding } of flattened) el.style.padding = padding;
      row.removeAttribute("data-md-header-row");
      row.removeAttribute("data-md-grid");
      row.removeAttribute("data-md-aligned");
      titleBlock.removeAttribute("data-md-titleblock");
      for (const el of markedActions) el.removeAttribute("data-md-actions");
      markedActions.clear();
      heading.removeAttribute("data-md-title");
      subtitle?.removeAttribute("data-md-subtitle");
      for (const button of hidden) button.style.display = "";
      hidden.clear();
      if (pushed) pushed.style.marginLeft = pushedWas;
      pushed = null;
    },
  };
}
