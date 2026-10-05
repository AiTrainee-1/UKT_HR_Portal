import { ArrowUpRight } from "lucide-react";
import { Link } from "wouter";
import AskAiButton from "@/components/md/kit/AskAiButton";
import type { MdMe } from "@/lib/md/types";
import { exploreTiles } from "./logic";
import { GroupHeading } from "./parts";

/** A tile for every other page, with the page's own one-line description and a shortcut to ask the assistant about it. */
export default function ExploreSection({ pages }: { pages: MdMe["pages"] | undefined }) {
  const tiles = exploreTiles(pages);
  return (
    <section aria-labelledby="md-explore-heading" className="@container" data-testid="md-dashboard-explore">
      <GroupHeading id="md-explore-heading" title="Explore">
        Everything behind these numbers, one page each
      </GroupHeading>
      <div className="grid grid-cols-1 gap-3 @lg:grid-cols-2 @4xl:grid-cols-4">
        {tiles.map((tile) => {
          const Icon = tile.icon;
          return (
            <div
              key={tile.id}
              className="flex flex-col justify-between gap-3 rounded-2xl p-4 clay-card"
              data-testid={`md-explore-${tile.id}`}
            >
              <Link href={tile.path} className="group block">
                <div className="flex items-center gap-2.5">
                  <span className="rounded-xl bg-[#006496]/[0.08] p-2 text-[#006496]">
                    <Icon size={16} />
                  </span>
                  <h4 className="min-w-0 flex-1 truncate text-sm font-bold text-[#1a3a4a] group-hover:text-[#006496]">
                    {tile.title}
                  </h4>
                  <ArrowUpRight
                    size={14}
                    className="shrink-0 text-[#006496]/50 transition-transform group-hover:translate-x-0.5"
                  />
                </div>
                {tile.summary && (
                  <p className="mt-2 line-clamp-3 text-xs leading-relaxed text-muted-foreground">{tile.summary}</p>
                )}
              </Link>
              <AskAiButton question={tile.question} label="Ask about this" className="self-start" />
            </div>
          );
        })}
      </div>
    </section>
  );
}
