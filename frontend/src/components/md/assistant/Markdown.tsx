import { Fragment, useMemo, type ReactNode } from "react";
import { parseMarkdown, type Block, type Inline } from "@/lib/md/markdown";
import { cn } from "@/lib/utils";

function renderInline(nodes: Inline[], keyPrefix = ""): ReactNode[] {
  return nodes.map((node, i) => {
    const key = `${keyPrefix}${i}`;
    switch (node.t) {
      case "b":
        return (
          <strong key={key} className="font-extrabold tabular-nums text-md-wine-700">
            {renderInline(node.c, `${key}-`)}
          </strong>
        );
      case "i":
        return <em key={key}>{renderInline(node.c, `${key}-`)}</em>;
      case "code":
        return (
          <code
            key={key}
            className="rounded-md border border-md-warning-400/25 bg-md-sand px-1.5 py-0.5 font-mono text-[12px] text-md-wine-800"
          >
            {node.v}
          </code>
        );
      default:
        return (
          <Fragment key={key}>
            {node.v.split("\n").map((line, n) => (
              <Fragment key={n}>
                {n > 0 && <br />}
                {line}
              </Fragment>
            ))}
          </Fragment>
        );
    }
  });
}

function BlockView({ block }: { block: Block }) {
  switch (block.t) {
    case "h":
      return (
        <p
          className={cn(
            "font-black leading-snug tracking-tight",
            block.level === 1 ? "text-[15.5px] text-md-ink" : "text-[13.5px] text-md-wine-700",
          )}
        >
          {renderInline(block.c)}
        </p>
      );
    case "ul":
      return (
        <ul className="space-y-1.5">
          {block.items.map((item, i) => (
            <li key={i} className="flex gap-2">
              <span
                className="mt-[0.6em] h-1.5 w-1.5 shrink-0 rounded-full bg-md-wine-400 ring-2 ring-md-wine/10"
                aria-hidden
              />
              <span className="min-w-0">{renderInline(item)}</span>
            </li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol className="space-y-1.5">
          {block.items.map((item, i) => (
            <li key={i} className="flex gap-2">
              <span className="md-assistant-ol-no">{i + 1}</span>
              <span className="min-w-0">{renderInline(item)}</span>
            </li>
          ))}
        </ol>
      );
    case "table":
      return (
        <div className="md-assistant-table overflow-x-auto">
          <table className="w-full min-w-max text-[12.5px]">
            <thead>
              <tr>
                {block.head.map((cell, c) => (
                  <th key={c} style={{ textAlign: block.align[c] }}>
                    {renderInline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} className="tabular-nums" style={{ textAlign: block.align[c] }}>
                      {renderInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "hr":
      return <hr className="border-md-line" />;
    default:
      return <p>{renderInline(block.c)}</p>;
  }
}

/** The assistant's answer: a safe subset of markdown rendered as elements (never as an HTML string). */
export default function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div
      className={cn("md-assistant-md space-y-2.5 text-[13.5px] leading-relaxed text-md-ink", className)}
      data-testid="assistant-markdown"
    >
      {blocks.map((block, i) => (
        <BlockView key={i} block={block} />
      ))}
    </div>
  );
}
