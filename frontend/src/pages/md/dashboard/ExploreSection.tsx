import { ArrowUpRight } from "lucide-react";
import { Link } from "wouter";
import AskAiButton from "@/components/md/kit/AskAiButton";
import type { MdMe } from "@/lib/md/types";
import { cn } from "@/lib/utils";
import { exploreTiles } from "./logic";
import { GroupHeading } from "./parts";

/** The icon tiles take wine, midnight indigo and sand in turn (sage, ochre and crimson stay for good, watch and bad). */
const TILE_COLOURS = ["wine", "ink", "sand"] as const;

/** A tile for every other page, with the page's own one-line description and a shortcut to ask the assistant about it.
 *  Each tile is a glass card that lifts on hover, the arrow of its link turning wine. */
export default function ExploreSection({ pages }: { pages: MdMe["pages"] | undefined }) {
  const tiles = exploreTiles(pages);
  return (
    <section aria-labelledby="md-explore-heading" className="@container" data-testid="md-dashboard-explore">
      <GroupHeading id="md-explore-heading" title="Explore">
        Everything behind these numbers, one page each
      </GroupHeading>
      <div className="grid grid-cols-2 gap-3 @lg:gap-4 @4xl:grid-cols-4">
        {tiles.map((tile, i) => {
          const Icon = tile.icon;
          return (
            <div
              key={tile.id}
              className="md-card md-dashboard-explore flex flex-col justify-between gap-3 p-3 @lg:gap-3.5 @lg:p-4"
              data-interactive=""
              data-testid={`md-explore-${tile.id}`}
            >
              <Link href={tile.path} className="group block rounded-xl">
                <div className="flex items-center gap-2 @lg:gap-3">
                  <span
                    className={cn(
                      "md-dashboard-icon md-dashboard-icon-sm",
                      `md-dashboard-icon-${TILE_COLOURS[i % TILE_COLOURS.length]}`,
                    )}
                  >
                    <Icon size={15} aria-hidden />
                  </span>
                  <h4 className="line-clamp-2 min-w-0 flex-1 text-[13px] font-extrabold leading-tight tracking-tight text-md-ink group-hover:text-md-wine @lg:truncate @lg:text-sm">
                    {tile.title}
                  </h4>
                  <ArrowUpRight
                    size={15}
                    aria-hidden
                    className="md-dashboard-explore-arrow hidden shrink-0 @lg:block"
                  />
                </div>
                {tile.summary && (
                  <p className="mt-2 line-clamp-3 text-[11px] leading-snug text-md-ink-soft @lg:mt-2.5 @lg:text-xs @lg:leading-relaxed">
                    {tile.summary}
                  </p>
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
