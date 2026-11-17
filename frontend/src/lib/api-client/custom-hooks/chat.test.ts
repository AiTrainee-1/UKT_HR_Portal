import { describe, expect, it } from "vitest";
import { canPostToAllBranches, type ChatChannelItem } from "./chat";

const channel = (id: number, type: ChatChannelItem["type"] = "company"): Pick<ChatChannelItem, "id" | "type"> => ({
  id,
  type,
});

describe("posting in every branch's company chat", () => {
  it("is for a viewer with more than one company chat, while one of them is open", () => {
    const admin = [channel(1), channel(2), channel(3)];
    expect(canPostToAllBranches(admin, admin[0])).toBe(true);
    expect(canPostToAllBranches(admin, admin[2])).toBe(true);
  });

  it("is not for a viewer with one company chat (an HR login limited to a branch, or an employee)", () => {
    expect(canPostToAllBranches([channel(1)], channel(1))).toBe(false);
    expect(canPostToAllBranches([channel(1), channel(9, "department")], channel(1))).toBe(false);
  });

  it("is not while a department chat, a chat outside the list, or nothing is open", () => {
    const admin = [channel(1), channel(2), channel(9, "department")];
    expect(canPostToAllBranches(admin, admin[2])).toBe(false);
    expect(canPostToAllBranches(admin, channel(77))).toBe(false);
    expect(canPostToAllBranches(admin, null)).toBe(false);
    expect(canPostToAllBranches(undefined, channel(1))).toBe(false);
  });
});
