import { Fragment, useMemo, type ReactNode } from "react";
import { parseMarkdown, type Block, type Inline } from "@/lib/md/markdown";
import { cn } from "@/lib/utils";

function renderInline(nodes: Inline[], keyPrefix = ""): ReactNode[] {
  return nodes.map((node, i) => {
    const key = `${keyPrefix}${i}`;
    switch (node.t) {
      case "b":
        return (
          <strong key={key} className="font-bold text-gray-950">
            {renderInline(node.c, `${key}-`)}
          </strong>
        );
      case "i":
        return <em key={key}>{renderInline(node.c, `${key}-`)}</em>;
      case "code":
        return (
          <code key={key} className="rounded bg-[#006496]/[0.08] px-1 py-0.5 font-mono text-[12px]">
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
        <p className={cn("font-extrabold text-gray-950", block.level === 1 ? "text-[15px]" : "text-[13.5px]")}>
          {renderInline(block.c)}
        </p>
      );
    case "ul":
      return (
        <ul className="space-y-1.5">
          {block.items.map((item, i) => (
            <li key={i} className="flex gap-2">
              <span className="mt-[0.55em] h-1.5 w-1.5 shrink-0 rounded-full bg-[#e0a83a]" aria-hidden />
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
              <span className="w-4 shrink-0 text-right font-bold tabular-nums text-[#006496]/70">{i + 1}.</span>
              <span className="min-w-0">{renderInline(item)}</span>
            </li>
          ))}
        </ol>
      );
    case "table":
      return (
        <div className="overflow-x-auto rounded-xl border border-[#006496]/10">
          <table className="w-full min-w-max text-[12.5px]">
            <thead>
              <tr className="bg-[#006496]/[0.05]">
                {block.head.map((cell, c) => (
                  <th
                    key={c}
                    className="px-2.5 py-1.5 text-[10.5px] font-bold uppercase tracking-wider text-[#006496]/70"
                    style={{ textAlign: block.align[c] }}
                  >
                    {renderInline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r} className="border-t border-[#006496]/[0.07]">
                  {row.map((cell, c) => (
                    <td key={c} className="px-2.5 py-1.5 tabular-nums" style={{ textAlign: block.align[c] }}>
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
      return <hr className="border-[#006496]/10" />;
    default:
      return <p>{renderInline(block.c)}</p>;
  }
}

/** The assistant's answer: a safe subset of markdown rendered as elements (never as an HTML string). */
export default function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div
      className={cn("space-y-2.5 text-[13.5px] leading-relaxed text-[#1a3a4a]", className)}
      data-testid="assistant-markdown"
    >
      {blocks.map((block, i) => (
        <BlockView key={i} block={block} />
      ))}
    </div>
  );
}
