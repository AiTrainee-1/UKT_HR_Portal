import { afterEach, describe, expect, it } from "vitest";
import { adoptHeaderRow, findHeader } from "./headerRow";

// jsdom has no stylesheet, so the layout the HR pages get from Tailwind classes is given inline here.
const FLEX = "display:flex;justify-content:space-between;align-items:center";

let root: HTMLElement;
const mount = (html: string) => {
  root = document.createElement("div");
  root.innerHTML = html;
  document.body.append(root);
  return root;
};
afterEach(() => root?.remove());

/** The shape most HR pages have: [title block | buttons] in a spread-out flex row. */
const STANDARD = `
  <div style="display:block">
    <div id="row" style="${FLEX}">
      <div id="block"><h2>Branches <span>3 pending</span></h2><p>Manage company locations</p></div>
      <div id="actions"><button data-testid="button-page-refresh">Refresh</button><button>Add Branch</button></div>
    </div>
    <div id="content">the rest of the page</div>
  </div>`;

describe("finding the page's title row", () => {
  it("takes the spread-out flex row around the page's first heading", () => {
    const found = findHeader(mount(STANDARD));
    expect(found?.row.id).toBe("row");
    expect(found?.titleBlock.id).toBe("block");
    expect(found?.subtitle?.textContent).toBe("Manage company locations");
  });

  it("prefers the spread-out row over a flex cluster of an icon and the title inside it", () => {
    const found = findHeader(
      mount(`
        <div id="row" style="${FLEX}">
          <div id="cluster" style="display:flex;justify-content:flex-start"><svg></svg><div id="block"><h2>Requests</h2><p>x</p></div></div>
          <button>Refresh</button>
        </div>`),
    );
    expect(found?.row.id).toBe("row");
    expect(found?.titleBlock.id).toBe("cluster");
  });

  it("settles for the nearest flex row when none spreads out (a title row with a back button)", () => {
    const found = findHeader(
      mount(`
        <div id="row" style="display:flex;gap:12px">
          <button>back</button><div id="block"><h1>Report Log</h1><p>x</p></div><span>Strict Mode</span>
        </div>`),
    );
    expect(found?.row.id).toBe("row");
    expect(found?.titleBlock.id).toBe("block");
  });

  it("reads the subtitle from under the row when the row holds only the heading and a button", () => {
    const found = findHeader(
      mount(`
        <div>
          <div id="row" style="${FLEX}"><h2>Attendance Search</h2><button>Refresh</button></div>
          <p id="sub">Find an employee</p>
        </div>`),
    );
    expect(found?.titleBlock.tagName).toBe("H2");
    expect(found?.subtitle?.id).toBe("sub");
  });

  it("finds nothing when there is no heading, or no flex row around it", () => {
    expect(findHeader(mount("<div><p>loading</p></div>"))).toBeNull();
    expect(findHeader(mount("<div><div><h2>Plain</h2></div></div>"))).toBeNull();
  });
});

describe("adopting the row", () => {
  it("puts the slots where the design has them: after the title block, last in the row, under the row", () => {
    const a = adoptHeaderRow(mount(STANDARD));
    expect(a).not.toBeNull();
    const row = root.querySelector("#row")!;
    expect([...row.children].map((c) => c.id || c.getAttribute("data-md-slot"))).toEqual([
      "block",
      "mid",
      "actions",
      "end",
    ]);
    expect(row.nextElementSibling?.getAttribute("data-md-slot")).toBe("below");
    expect(a!.read()).toEqual({ title: "Branches", subtitle: "Manage company locations" });
  });

  it("puts the strip under the subtitle when the subtitle is the row's sibling", () => {
    const a = adoptHeaderRow(
      mount(
        `<div><div id="row" style="${FLEX}"><h2>Attendance Search</h2><button>Refresh</button></div><p id="sub">Find</p></div>`,
      ),
    );
    expect(a!.row.nextElementSibling?.id).toBe("sub");
    expect(root.querySelector("#sub")?.nextElementSibling?.getAttribute("data-md-slot")).toBe("below");
  });

  it("hides the page's own Refresh buttons (the shared stack replaces them) and no other button", () => {
    adoptHeaderRow(mount(STANDARD));
    const [refresh, add] = [...root.querySelectorAll<HTMLElement>("#actions button")];
    expect(refresh.style.display).toBe("none");
    expect(add.style.display).toBe("");
  });

  it("lets the row wrap, so the added pieces do not squeeze the page's buttons", () => {
    adoptHeaderRow(mount(STANDARD));
    expect(root.querySelector<HTMLElement>("#row")!.style.flexWrap).toBe("wrap");
  });

  it("takes the padding off a page's own width-limited container, and gives it back", () => {
    const a = adoptHeaderRow(
      mount(
        `<div id="page" style="max-width:1500px;padding:24px"><div style="${FLEX}"><div><h2>Report Log</h2></div><span>x</span></div></div>`,
      ),
    )!;
    const page = root.querySelector<HTMLElement>("#page")!;
    expect(page.style.padding).toBe("0px");
    a.release();
    expect(page.style.padding).toBe("24px");
  });

  it("leaves a padded container alone when it has no width limit of its own", () => {
    adoptHeaderRow(
      mount(
        `<div id="page" style="padding:24px"><div style="${FLEX}"><div><h2>Plain</h2></div><span>x</span></div></div>`,
      ),
    );
    expect(root.querySelector<HTMLElement>("#page")!.style.padding).toBe("24px");
  });

  it("spaces the strip from a subtitle that sits outside the row, and not otherwise", () => {
    const outside = adoptHeaderRow(
      mount(`<div><div style="${FLEX}"><h2>Search</h2><button>x</button></div><p>Find</p></div>`),
    )!;
    expect(outside.below.style.marginTop).toBe("1.25rem");
    root.remove();
    expect(adoptHeaderRow(mount(STANDARD))!.below.style.marginTop).toBe("");
  });

  it("puts the Live chip inside the heading, after its words, and does not mistake it for the title", () => {
    const a = adoptHeaderRow(mount(STANDARD))!;
    const h2 = root.querySelector("h2")!;
    expect(h2.lastElementChild).toBe(a.live);
    a.live.textContent = "Live";
    expect(a.read().title).toBe("Branches");
  });

  it("pushes the page's buttons to the right of the row, wrapped or not", () => {
    adoptHeaderRow(mount(STANDARD));
    expect(root.querySelector<HTMLElement>("#actions")!.style.marginLeft).toBe("auto");
  });

  it("does not hide the stack's own Refresh button along with the page's", () => {
    const a = adoptHeaderRow(mount(STANDARD))!;
    const own = document.createElement("button");
    own.setAttribute("data-testid", "md-refresh");
    own.textContent = "Refresh";
    a.end.append(own);
    a.tidy();
    expect(own.style.display).toBe("");
  });

  it("pins the stack in the corner when the page is wide, and lets it flow when it is narrow", () => {
    const a = adoptHeaderRow(mount(STANDARD))!;
    const row = root.querySelector<HTMLElement>("#row")!;
    const width = (px: number) => Object.defineProperty(root, "clientWidth", { value: px, configurable: true });

    width(1100);
    a.layout();
    expect(a.end.style.position).toBe("absolute");
    expect(a.end.style.right).toBe("0px");
    expect(row.style.paddingRight).not.toBe("");
    expect(row.style.position).toBe("relative");

    width(400);
    a.layout();
    expect(a.end.style.position).toBe("");
    expect(a.end.style.display).toBe("contents");
    expect(row.style.paddingRight).toBe("");
  });

  it("puts everything back on release", () => {
    const before = [...mount(STANDARD).querySelectorAll("*")].map((el) => el.tagName + el.id);
    const a = adoptHeaderRow(root)!;
    a.release();
    expect([...root.querySelectorAll("*")].map((el) => el.tagName + el.id)).toEqual(before);
    expect(root.querySelector("[data-md-slot], [data-md-title], [data-md-subtitle], [data-md-header-row]")).toBeNull();
    expect(root.querySelector<HTMLElement>("#row")!.style.flexWrap).toBe("");
    expect(root.querySelector<HTMLElement>("#actions button")!.style.display).toBe("");
  });

  it("notices the page re-rendering its header, and puts the slots back in place", () => {
    const a = adoptHeaderRow(mount(STANDARD))!;
    expect(a.intact()).toBe(true);

    // the page adds a new last child (a button that appears later): the stack must stay last
    const row = root.querySelector("#row")!;
    const late = document.createElement("button");
    late.textContent = "Late";
    row.append(late);
    a.tidy();
    expect(row.lastElementChild?.getAttribute("data-md-slot")).toBe("end");

    // the page throws the whole row away: not intact any more
    row.remove();
    expect(a.intact()).toBe(false);
  });

  it("follows the title when the page changes it", () => {
    const a = adoptHeaderRow(mount(STANDARD))!;
    root.querySelector("h2")!.firstChild!.textContent = "Locations ";
    expect(a.read().title).toBe("Locations");
  });

  it("hides a Refresh button that shows up later", () => {
    const a = adoptHeaderRow(mount(STANDARD))!;
    const late = document.createElement("button");
    late.textContent = " Refresh ";
    root.querySelector("#actions")!.append(late);
    a.tidy();
    expect(late.style.display).toBe("none");
  });

  it("does not adopt a page with no usable row", () => {
    expect(adoptHeaderRow(mount("<div><div><h2>Plain</h2></div></div>"))).toBeNull();
  });
});
