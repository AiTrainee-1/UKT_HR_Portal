// A small, safe markdown parser for the assistant's answers: paragraphs, headings, bullet and numbered lists, tables,
// **bold**, *italic* and `code`. It produces a plain data tree that a component turns into React elements, so there is no
// HTML string anywhere (nothing the model writes can inject markup) and no links are rendered at all.

export type Inline =
  { t: "text"; v: string } | { t: "b"; c: Inline[] } | { t: "i"; c: Inline[] } | { t: "code"; v: string };

export type Align = "left" | "right" | "center";

export type Block =
  | { t: "p"; c: Inline[] }
  | { t: "h"; level: 1 | 2 | 3; c: Inline[] }
  | { t: "ul"; items: Inline[][] }
  | { t: "ol"; items: Inline[][] }
  | { t: "table"; head: Inline[][]; rows: Inline[][][]; align: Align[] }
  | { t: "hr" };

const WORD = /[\p{L}\p{N}]/u;
const isWordChar = (ch: string | undefined) => !!ch && WORD.test(ch);

/** Text with **bold**, *italic*, _italic_ and `code`. An unmatched marker is just text. */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ t: "text", v: text });
    text = "";
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\" && i + 1 < src.length && "\\`*_{}[]()#+-.!|>".includes(src[i + 1])) {
      text += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === "`") {
      const end = src.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        out.push({ t: "code", v: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if ((ch === "*" || ch === "_") && src[i + 1] === ch) {
      const end = src.indexOf(ch + ch, i + 2);
      if (end > i + 2) {
        flush();
        out.push({ t: "b", c: parseInline(src.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if (ch === "*" || ch === "_") {
      const next = src[i + 1];
      const before = src[i - 1];
      const opens = next !== undefined && !/\s/.test(next) && (ch === "*" || !isWordChar(before));
      if (opens) {
        let end = i + 1;
        while ((end = src.indexOf(ch, end)) !== -1) {
          const closes = !/\s/.test(src[end - 1]) && src[end + 1] !== ch && (ch === "*" || !isWordChar(src[end + 1]));
          if (closes && end > i + 1) break;
          end += 1;
        }
        if (end !== -1) {
          flush();
          out.push({ t: "i", c: parseInline(src.slice(i + 1, end)) });
          i = end + 1;
          continue;
        }
      }
    }
    text += ch;
    i += 1;
  }
  flush();
  return out;
}

const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const HEADING = /^(#{1,3})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function alignOf(cell: string): Align {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  return left && right ? "center" : right ? "right" : "left";
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ t: "p", c: parseInline(paragraph.join("\n")) });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      flushParagraph();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({ t: "h", level: heading[1].length as 1 | 2 | 3, c: parseInline(heading[2]) });
      continue;
    }
    if (RULE.test(line)) {
      flushParagraph();
      blocks.push({ t: "hr" });
      continue;
    }
    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      TABLE_SEPARATOR.test(lines[i + 1]) &&
      lines[i + 1].includes("-")
    ) {
      flushParagraph();
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map(alignOf);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
        const cells = splitRow(lines[i]);
        rows.push(head.map((_, c) => parseInline(cells[c] ?? "")));
        i += 1;
      }
      i -= 1;
      blocks.push({
        t: "table",
        head: head.map((h) => parseInline(h)),
        rows,
        align: head.map((_, c) => align[c] ?? "left"),
      });
      continue;
    }
    const isBullet = BULLET.test(line) && !RULE.test(line);
    const isNumbered = NUMBERED.test(line);
    if (isBullet || isNumbered) {
      flushParagraph();
      const pattern = isBullet ? BULLET : NUMBERED;
      const items: Inline[][] = [];
      while (i < lines.length) {
        const match = pattern.exec(lines[i]);
        if (match && !(isBullet && RULE.test(lines[i]))) {
          items.push(parseInline(match[1]));
        } else if (lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && items.length) {
          items[items.length - 1].push({ t: "text", v: " " }, ...parseInline(lines[i].trim())); // a wrapped item line
        } else {
          break;
        }
        i += 1;
      }
      i -= 1;
      blocks.push({ t: isBullet ? "ul" : "ol", items });
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  return blocks;
}

function inlineText(nodes: Inline[]): string {
  return nodes.map((n) => (n.t === "text" || n.t === "code" ? n.v : inlineText(n.c))).join("");
}

/** The answer as plain text, for copying and for text-to-speech: markers gone, lists as sentences, tables as rows. */
export function stripMarkdown(src: string): string {
  return parseMarkdown(src)
    .map((block) => {
      switch (block.t) {
        case "p":
        case "h":
          return inlineText(block.c).replace(/\s*\n\s*/g, " ");
        case "ul":
        case "ol":
          return block.items.map((item) => inlineText(item)).join(". ");
        case "table":
          return block.rows
            .map((row) => row.map((cell, c) => `${inlineText(block.head[c])} ${inlineText(cell)}`).join(", "))
            .join(". ");
        default:
          return "";
      }
    })
    .filter(Boolean)
    .join("\n");
}
