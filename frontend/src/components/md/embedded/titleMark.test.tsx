import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useTitleMark } from "./titleMark";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function Page({ children }: { children: React.ReactNode }) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  useTitleMark(el);
  return <div ref={setEl}>{children}</div>;
}

const marked = () => [...host.querySelectorAll("[data-md-title]")].map((e) => e.textContent);

describe("useTitleMark", () => {
  it("marks the first heading of a page as its title", () => {
    act(() =>
      root.render(
        <Page>
          <h2>Add New Employee</h2>
          <h3>Basic information</h3>
        </Page>,
      ),
    );
    expect(marked()).toEqual(["Add New Employee"]);
  });

  it("marks an h1 that is the page's heading, and nothing when there is no heading", () => {
    act(() =>
      root.render(
        <Page>
          <h1>Employee</h1>
        </Page>,
      ),
    );
    expect(marked()).toEqual(["Employee"]);
    act(() =>
      root.render(
        <Page>
          <p>no heading yet</p>
        </Page>,
      ),
    );
    expect(marked()).toEqual([]);
  });

  it("follows a heading that appears after the page has loaded", async () => {
    function Late() {
      const [ready, setReady] = useState(false);
      return (
        <Page>
          <button onClick={() => setReady(true)}>load</button>
          {ready && <h2>Loaded title</h2>}
        </Page>
      );
    }
    act(() => root.render(<Late />));
    expect(marked()).toEqual([]);
    await act(async () => host.querySelector("button")!.click());
    await act(async () => {});
    expect(marked()).toEqual(["Loaded title"]);
  });

  it("takes its marks off again when the page goes away", () => {
    act(() =>
      root.render(
        <Page>
          <h2>Title</h2>
        </Page>,
      ),
    );
    const heading = host.querySelector("h2")!;
    expect(heading.hasAttribute("data-md-title")).toBe(true);
    act(() => root.render(<p>another page</p>));
    expect(heading.hasAttribute("data-md-title")).toBe(false);
  });
});
