import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown, stripMarkdown } from "./markdown";

const text = (v: string) => ({ t: "text", v });

describe("parseInline", () => {
  it("reads bold, italic and code", () => {
    expect(parseInline("a **b** c *d* e `f`")).toEqual([
      text("a "),
      { t: "b", c: [text("b")] },
      text(" c "),
      { t: "i", c: [text("d")] },
      text(" e "),
      { t: "code", v: "f" },
    ]);
  });

  it("nests italic inside bold and accepts underscore forms", () => {
    expect(parseInline("**very *good* news**")).toEqual([
      { t: "b", c: [text("very "), { t: "i", c: [text("good")] }, text(" news")] },
    ]);
    expect(parseInline("__bold__ and _soft_")).toEqual([
      { t: "b", c: [text("bold")] },
      text(" and "),
      { t: "i", c: [text("soft")] },
    ]);
  });

  it("leaves unmatched or spaced markers alone, and underscores inside words", () => {
    expect(parseInline("5 * 3 = 15")).toEqual([text("5 * 3 = 15")]);
    expect(parseInline("a **b")).toEqual([text("a **b")]);
    expect(parseInline("run snake_case_name now")).toEqual([text("run snake_case_name now")]);
    expect(parseInline("a ` b")).toEqual([text("a ` b")]);
  });

  it("honours a backslash escape and never produces markup from HTML", () => {
    expect(parseInline("\\*not italic\\*")).toEqual([text("*not italic*")]);
    expect(parseInline("<script>alert(1)</script> <b>x</b>")).toEqual([text("<script>alert(1)</script> <b>x</b>")]);
  });

  it("keeps Tamil and Hindi text intact", () => {
    expect(parseInline("**வருகை** சரி")).toEqual([{ t: "b", c: [text("வருகை")] }, text(" சரி")]);
    expect(parseInline("_उपस्थिति_ ठीक")).toEqual([{ t: "i", c: [text("उपस्थिति")] }, text(" ठीक")]);
  });
});

describe("parseMarkdown", () => {
  it("makes paragraphs, keeping line breaks inside one", () => {
    expect(parseMarkdown("First line\nsecond line\n\nNew paragraph")).toEqual([
      { t: "p", c: [text("First line\nsecond line")] },
      { t: "p", c: [text("New paragraph")] },
    ]);
  });

  it("reads headings, rules and both kinds of list", () => {
    const blocks = parseMarkdown("## Summary\n- one\n- **two**\n\n1. first\n2) second\n\n---");
    expect(blocks).toEqual([
      { t: "h", level: 2, c: [text("Summary")] },
      { t: "ul", items: [[text("one")], [{ t: "b", c: [text("two")] }]] },
      { t: "ol", items: [[text("first")], [text("second")]] },
      { t: "hr" },
    ]);
  });

  it("accepts the bullet characters models use", () => {
    expect(parseMarkdown("• a\n* b\n- c")).toEqual([{ t: "ul", items: [[text("a")], [text("b")], [text("c")]] }]);
  });

  it("joins a wrapped list line to its item", () => {
    expect(parseMarkdown("- first part\n  continued\n- second")).toEqual([
      { t: "ul", items: [[text("first part"), text(" "), text("continued")], [text("second")]] },
    ]);
  });

  it("reads a table with alignment, padding short rows", () => {
    const [table] = parseMarkdown("| Unit | Absent | Rate |\n|:--|--:|:-:|\n| One | 12 | 4.2% |\n| Two | 8 |");
    expect(table.t).toBe("table");
    if (table.t !== "table") return;
    expect(table.align).toEqual(["left", "right", "center"]);
    expect(table.head).toHaveLength(3);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[1][2]).toEqual([]); // a missing cell is empty, not a crash
    expect(table.rows[0][1]).toEqual([text("12")]);
  });

  it("does not take a lone pipe line without a separator for a table", () => {
    expect(parseMarkdown("a | b")).toEqual([{ t: "p", c: [text("a | b")] }]);
  });

  it("copes with Windows line endings, blank input and a list that follows text", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("x\r\n\r\n- y")).toEqual([
      { t: "p", c: [text("x")] },
      { t: "ul", items: [[text("y")]] },
    ]);
    expect(parseMarkdown("intro\n- item")).toEqual([
      { t: "p", c: [text("intro")] },
      { t: "ul", items: [[text("item")]] },
    ]);
  });
});

describe("stripMarkdown", () => {
  it("turns an answer into speakable plain text", () => {
    const answer =
      "**14 employees** were absent.\n\n- Stitching had *6*\n- Packing had 4\n\n| Unit | Absent |\n|--|--|\n| One | 9 |";
    expect(stripMarkdown(answer)).toBe("14 employees were absent.\nStitching had 6. Packing had 4\nUnit One, Absent 9");
  });

  it("drops rules and keeps headings as sentences", () => {
    expect(stripMarkdown("# Title\n---\nBody")).toBe("Title\nBody");
  });
});
