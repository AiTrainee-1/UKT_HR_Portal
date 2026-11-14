import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ThinkingLine, { currentStep } from "./ThinkingLine";

describe("the one-line loader", () => {
  it("names only the step the assistant is on, without its trailing dots", () => {
    expect(currentStep([])).toBe("Reading your question");
    expect(
      currentStep([
        { label: "Reading your question", state: "done" },
        { label: "Looking at workforce find employees...", state: "running" },
        { label: "Working out the answer…", state: "done" },
      ]),
    ).toBe("Looking at workforce find employees");
    expect(currentStep([{ label: "Working out the answer…", state: "done" }])).toBe("Working out the answer");
  });

  it("is one line: one label and three dots, no list of steps", () => {
    const html = renderToStaticMarkup(
      <ThinkingLine
        lines={[
          { label: "Reading your question", state: "done" },
          { label: "Thinking it through...", state: "done" },
          { label: "Looking at custom data query...", state: "running" },
        ]}
      />,
    );
    expect(html).not.toContain("<li");
    expect(html.match(/data-testid="assistant-progress-label"/g)).toHaveLength(1);
    expect(html).toContain("Looking at custom data query");
    expect(html).not.toContain("Thinking it through");
    expect(html).toContain('role="status"');
  });
});
