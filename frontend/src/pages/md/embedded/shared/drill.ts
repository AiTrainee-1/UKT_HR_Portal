/**
 * A click handler for a whole card that opens a drill-down (kit StatCard `onClick`), which ignores clicks that belong to
 * something else inside the card: its "how is this calculated?" or Ask AI button, a link, and anything in a popover the
 * card opened (a portal: React still bubbles its clicks to the card, but the DOM target is not inside the card).
 *
 *   <StatCard onClick={drillClick(() => openSheet("late"))} ... />
 */
export function drillClick(open: () => void): (...args: unknown[]) => void {
  return (...args: unknown[]) => {
    const event = args[0] as { target?: unknown; currentTarget?: unknown } | undefined;
    const target = event?.target;
    const card = event?.currentTarget;
    if (target instanceof Element && card instanceof Element) {
      if (!card.contains(target)) return; // a click in a popover the card opened
      const inner = target.closest("button, a, [role='dialog'], [data-radix-popper-content-wrapper]");
      if (inner && inner !== card && card.contains(inner)) return; // the card's own buttons
    }
    open();
  };
}
