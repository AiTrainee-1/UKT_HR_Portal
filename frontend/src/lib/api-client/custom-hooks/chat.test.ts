import { describe, expect, it } from "vitest";
import { canPostToAllBranches, parseMediaExpiryDays, type ChatChannelItem } from "./chat";

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

describe("Chat media expiry (days)", () => {
  it("takes a whole number from 1 to 90", () => {
    expect(parseMediaExpiryDays("7")).toEqual({ days: 7, error: null });
    expect(parseMediaExpiryDays(" 90 ")).toEqual({ days: 90, error: null });
    expect(parseMediaExpiryDays("1")).toEqual({ days: 1, error: null });
  });

  it("says why anything else cannot be saved", () => {
    expect(parseMediaExpiryDays("").error).toBe("Enter the number of days.");
    expect(parseMediaExpiryDays("0").error).toBe("Choose from 1 to 90 days.");
    expect(parseMediaExpiryDays("91").error).toBe("Choose from 1 to 90 days.");
    expect(parseMediaExpiryDays("2.5").error).toBe("Use a whole number of days from 1 to 90.");
    expect(parseMediaExpiryDays("-3").error).toBe("Use a whole number of days from 1 to 90.");
    expect(parseMediaExpiryDays("abc").days).toBeNull();
  });
});
