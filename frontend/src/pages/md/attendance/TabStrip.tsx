import SegTabs, { type SegItem } from "../embedded/shared/SegTabs";

/**
 * The tabs of a card, at the top of its body rather than in its header: on a phone a row of pills is wider than the card,
 * so it scrolls sideways inside this strip instead of pushing the whole page wider.
 */
export default function TabStrip({
  items,
  value,
  onChange,
  label,
}: {
  items: SegItem[];
  value: string;
  onChange: (value: string) => void;
  /** What the tabs choose, read out by a screen reader. */
  label?: string;
}) {
  return (
    <div className="mb-4 max-w-full" data-testid="md-tab-strip">
      <SegTabs items={items} value={value} onChange={onChange} label={label} />
    </div>
  );
}
