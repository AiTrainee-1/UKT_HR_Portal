import { describe, expect, it } from "vitest";
import { cn } from "./utils";

describe("cn", () => {
  it("joins classes and drops falsy values", () => {
    const off = Math.random() > 2;
    expect(cn("a", off && "b", undefined, "c")).toBe("a c");
  });

  it("lets a later Tailwind utility win over a conflicting earlier one", () => {
    expect(cn("px-2 py-1", "px-4")).toBe("py-1 px-4");
  });
});
