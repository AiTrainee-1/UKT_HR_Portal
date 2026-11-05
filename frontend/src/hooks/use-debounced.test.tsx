import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SEARCH_DEBOUNCE_MS, useDebounced, useDraft } from "./use-debounced";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  vi.useRealTimers();
});

const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));

describe("useDebounced", () => {
  it("follows the value only once it has stopped changing for the delay", () => {
    let seen = "";
    let setValue: (v: string) => void = () => {};
    function Probe() {
      const [value, set] = useState("");
      setValue = set;
      seen = useDebounced(value);
      return null;
    }
    act(() => root!.render(<Probe />));
    act(() => setValue("a"));
    wait(SEARCH_DEBOUNCE_MS - 50);
    act(() => setValue("ab"));
    wait(SEARCH_DEBOUNCE_MS - 50);
    expect(seen).toBe("");
    wait(50);
    expect(seen).toBe("ab");
  });
});

describe("useDraft", () => {
  type Box = { draft: string; change: (v: string) => void; owner: string; setOwner: (v: string) => void };
  const box = {} as Box;
  const commits: string[] = [];

  function Owner() {
    const [owner, setOwner] = useState("");
    const [draft, change] = useDraft(owner, (next) => {
      commits.push(next);
      setOwner(next);
    });
    Object.assign(box, { draft, change, owner, setOwner });
    return null;
  }

  beforeEach(() => {
    commits.length = 0;
    act(() => root!.render(<Owner />));
  });

  it("shows every letter at once and hands the text up once per pause", () => {
    act(() => box.change("a"));
    act(() => box.change("as"));
    act(() => box.change("ash"));
    expect(box.draft).toBe("ash");
    expect(box.owner).toBe("");
    wait(SEARCH_DEBOUNCE_MS);
    expect(commits).toEqual(["ash"]);
    expect(box.owner).toBe("ash");
  });

  it("commits an emptied box at once", () => {
    act(() => box.change("ash"));
    wait(SEARCH_DEBOUNCE_MS);
    act(() => box.change(""));
    expect(box.owner).toBe("");
    expect(commits).toEqual(["ash", ""]);
    wait(SEARCH_DEBOUNCE_MS);
    expect(commits).toEqual(["ash", ""]);
  });

  it("follows a change the owner makes itself (a Reset button, the address)", () => {
    act(() => box.change("ash"));
    wait(SEARCH_DEBOUNCE_MS);
    act(() => box.setOwner("ravi"));
    expect(box.draft).toBe("ravi");
    wait(SEARCH_DEBOUNCE_MS);
    expect(commits).toEqual(["ash"]);
  });
});
