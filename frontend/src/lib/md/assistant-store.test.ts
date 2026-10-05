import { afterEach, describe, expect, it } from "vitest";
import {
  clearPendingPrompt,
  closeAssistant,
  getAssistantState,
  openAssistant,
  setAssistantContext,
  toggleAssistant,
} from "./assistant-store";

afterEach(() => {
  closeAssistant();
  setAssistantContext(null);
  const pending = getAssistantState().prompt;
  if (pending) clearPendingPrompt(pending.nonce);
});

describe("assistant store", () => {
  it("opens, closes and toggles", () => {
    expect(getAssistantState().open).toBe(false);
    openAssistant();
    expect(getAssistantState().open).toBe(true);
    closeAssistant();
    expect(getAssistantState().open).toBe(false);
    toggleAssistant();
    expect(getAssistantState().open).toBe(true);
    toggleAssistant();
    expect(getAssistantState().open).toBe(false);
  });

  it("carries a question to ask, and each one is distinct so the same question can be asked twice", () => {
    openAssistant("Why is absenteeism high?");
    const first = getAssistantState().prompt;
    expect(first?.text).toBe("Why is absenteeism high?");
    openAssistant("Why is absenteeism high?");
    const second = getAssistantState().prompt;
    expect(second?.nonce).not.toBe(first?.nonce);
  });

  it("forgets the question once the panel has taken it, and ignores a stale claim", () => {
    openAssistant("What changed in payroll?");
    const current = getAssistantState().prompt!;
    clearPendingPrompt(current.nonce - 1); // someone else's
    expect(getAssistantState().prompt).not.toBeNull();
    clearPendingPrompt(current.nonce);
    expect(getAssistantState().prompt).toBeNull();
  });

  it("keeps opening without a question from losing one already waiting", () => {
    openAssistant("Waiting question");
    openAssistant();
    expect(getAssistantState().prompt?.text).toBe("Waiting question");
  });

  it("holds what the current page is showing", () => {
    setAssistantContext({ page: "payroll", title: "Payroll Analysis", filters: { Period: "Last month" } });
    expect(getAssistantState().context?.page).toBe("payroll");
    setAssistantContext(null);
    expect(getAssistantState().context).toBeNull();
  });
});
