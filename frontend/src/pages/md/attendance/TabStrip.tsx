import type { ComponentProps } from "react";
import { PillTabs } from "@/components/ui/pill-tabs";

/**
 * The tabs of a card, at the top of its body rather than in its header: on a phone a row of pills is wider than the card,
 * so it scrolls sideways inside this strip instead of pushing the whole page wider.
 */
export default function TabStrip(props: Omit<ComponentProps<typeof PillTabs>, "size">) {
  return (
    <div className="mb-3 max-w-full overflow-x-auto pb-1" data-testid="md-tab-strip">
      <PillTabs size="sm" {...props} />
    </div>
  );
}
