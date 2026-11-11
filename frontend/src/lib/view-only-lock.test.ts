import { afterEach, describe, expect, it } from "vitest";
import {
  isMutatingControl,
  lockIconOnlyDeletes,
  lockMutatingControls,
  setApprovalsSeparate,
  watchMutatingControls,
} from "./view-only-lock";

function button(label: string, attrs: Record<string, string> = {}): HTMLButtonElement {
  const el = document.createElement("button");
  el.textContent = label;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

describe("isMutatingControl", () => {
  it("flags buttons whose label is a mutating verb", () => {
    for (const label of ["Add Employee", "Save", "Delete", "Approve", "Generate Payroll", "Export"]) {
      expect(isMutatingControl(button(label)), label).toBe(true);
    }
  });

  it("leaves browsing controls alone", () => {
    for (const label of ["All Departments", "Next", "Search", "Filter", "Close"]) {
      expect(isMutatingControl(button(label)), label).toBe(false);
    }
  });

  it("matches whole words only", () => {
    expect(isMutatingControl(button("Address book"))).toBe(false);
    expect(isMutatingControl(button("Posting history"))).toBe(false);
  });

  it("also reads aria-label and title", () => {
    expect(isMutatingControl(button("", { "aria-label": "Delete row" }))).toBe(true);
    expect(isMutatingControl(button("", { title: "Edit" }))).toBe(true);
  });
});

describe("approvals as a right of their own (HR Manager / HR Assistant accounts)", () => {
  afterEach(() => setApprovalsSeparate(false));

  it("keeps Approve / Reject usable on a view-only page, every other change still locked", () => {
    setApprovalsSeparate(true);
    expect(isMutatingControl(button("Approve"))).toBe(false);
    expect(isMutatingControl(button("", { "aria-label": "Reject the request" }))).toBe(false);
    expect(isMutatingControl(button("Edit"))).toBe(true);
    expect(isMutatingControl(button("Approve and edit"))).toBe(true);
  });

  it("changes nothing for every other account", () => {
    setApprovalsSeparate(false);
    expect(isMutatingControl(button("Approve"))).toBe(true);
  });
});

describe("data-view-safe opt-out", () => {
  it("never locks a button inside a view-safe container, however it is named", () => {
    const root = document.createElement("div");
    root.setAttribute("data-view-safe", "");
    const inner = document.createElement("div");
    root.appendChild(inner);
    const b = button("Export to Excel");
    inner.appendChild(b);
    expect(isMutatingControl(b)).toBe(false);
    lockMutatingControls(root);
    expect(b.disabled).toBe(false);
  });

  it("honours the attribute on the button itself", () => {
    expect(isMutatingControl(button("Generate", { "data-view-safe": "" }))).toBe(false);
  });

  it("still locks the same button outside a view-safe container", () => {
    expect(isMutatingControl(button("Export to Excel"))).toBe(true);
    const other = document.createElement("div");
    const b = button("Delete");
    other.appendChild(b);
    lockMutatingControls(other);
    expect(b.disabled).toBe(true);
  });
});

describe("lockIconOnlyDeletes", () => {
  const bin = (extra = "") => `<button ${extra}><svg class="lucide lucide-trash-2"></svg></button>`;

  it("hides and disables a bin with no words, which the name check cannot see", () => {
    const root = document.createElement("div");
    root.innerHTML = bin('id="x"');
    expect(isMutatingControl(root.querySelector("#x") as HTMLButtonElement)).toBe(false);
    lockIconOnlyDeletes(root);
    const b = root.querySelector("#x") as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(b.style.display).toBe("none");
  });

  it("leaves other icon-only buttons, and buttons with words, alone", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<button id="eye"><svg class="lucide lucide-eye"></svg></button>' +
      '<button id="words"><svg class="lucide lucide-trash-2"></svg> Clear filters</button>' +
      '<button id="named" aria-label="Clear"><svg class="lucide lucide-trash"></svg></button>';
    lockIconOnlyDeletes(root);
    for (const id of ["eye", "words", "named"]) {
      expect((root.querySelector(`#${id}`) as HTMLButtonElement).disabled, id).toBe(false);
    }
  });

  it("respects a view-safe container", () => {
    const root = document.createElement("div");
    root.setAttribute("data-view-safe", "");
    root.innerHTML = bin('id="x"');
    lockIconOnlyDeletes(root);
    expect((root.querySelector("#x") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("lockMutatingControls", () => {
  it("disables only the mutating buttons and never touches inputs", () => {
    const root = document.createElement("div");
    root.innerHTML = '<button id="a">Save</button><button id="b">Next</button><input id="c" />';
    lockMutatingControls(root);
    expect((root.querySelector("#a") as HTMLButtonElement).disabled).toBe(true);
    expect((root.querySelector("#b") as HTMLButtonElement).disabled).toBe(false);
    expect((root.querySelector("#c") as HTMLInputElement).disabled).toBe(false);
  });
});

describe("watchMutatingControls", () => {
  // The observer reports in a microtask and the lock runs on the next frame.
  const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 40));
  const byId = (root: HTMLElement, id: string) => root.querySelector(`#${id}`) as HTMLButtonElement;
  let stop: (() => void) | undefined;
  let root: HTMLDivElement;

  function watch(html: string): HTMLDivElement {
    root = document.createElement("div");
    root.innerHTML = html;
    document.body.appendChild(root);
    stop = watchMutatingControls(root);
    return root;
  }

  afterEach(() => {
    stop?.();
    stop = undefined;
    root?.remove();
  });

  it("locks what is already there straight away", () => {
    watch('<button id="a">Delete</button><button id="b">Next</button>');
    expect(byId(root, "a").disabled).toBe(true);
    expect(byId(root, "b").disabled).toBe(false);
  });

  it("locks a mutating button that mounts later, however deep, and leaves the others alone", async () => {
    watch("<div id='host'></div>");
    const dialog = document.createElement("div");
    dialog.innerHTML = '<section><button id="save">Save changes</button><button id="close">Close</button></section>';
    root.querySelector("#host")!.appendChild(dialog);
    const lone = document.createElement("button");
    lone.id = "add";
    lone.textContent = "Add Employee";
    root.appendChild(lone);
    await nextFrame();
    expect(byId(root, "save").disabled).toBe(true);
    expect(byId(root, "add").disabled).toBe(true);
    expect(byId(root, "close").disabled).toBe(false);
  });

  it("locks a button whose name turns into a mutating one, by text or by its children", async () => {
    watch('<button id="t">View</button><button id="c"><span>View</span></button><button id="l">Open</button>');
    byId(root, "t").firstChild!.nodeValue = "Edit";
    byId(root, "c").replaceChildren(document.createTextNode("Approve"));
    byId(root, "l").setAttribute("aria-label", "Delete row");
    await nextFrame();
    expect(byId(root, "t").disabled).toBe(true);
    expect(byId(root, "c").disabled).toBe(true);
    expect(byId(root, "l").disabled).toBe(true);
  });

  it("locks a mutating button again when something re-enables it", async () => {
    watch('<button id="s">Save</button>');
    byId(root, "s").disabled = false;
    await nextFrame();
    expect(byId(root, "s").disabled).toBe(true);
  });

  it("locks what was inside a view-safe area once the opt-out goes", async () => {
    watch('<div id="safe" data-view-safe><button id="x">Export</button></div>');
    expect(byId(root, "x").disabled).toBe(false);
    root.querySelector("#safe")!.removeAttribute("data-view-safe");
    await nextFrame();
    expect(byId(root, "x").disabled).toBe(true);
  });

  it("stops watching when told to", async () => {
    watch("");
    stop!();
    stop = undefined;
    root.innerHTML = '<button id="late">Delete</button>';
    await nextFrame();
    expect(byId(root, "late").disabled).toBe(false);
  });
});
