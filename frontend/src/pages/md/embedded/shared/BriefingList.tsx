import { cn } from "@/lib/utils";

const TONE: Record<string, string> = {
  good: "md-analytics-tone-good",
  bad: "md-analytics-tone-bad",
  neutral: "md-analytics-tone-wine",
};

/**
 * The briefing: a few plain sentences written by the server from the figures on the page, on a sand panel, each led by a
 * dot (sage for good news, crimson for bad, wine for the rest). The sentence says the same thing in words.
 */
export default function BriefingList({
  sentences,
  testIdPrefix,
}: {
  sentences: { id: string; tone: string; text: string }[];
  /** Each sentence gets `${testIdPrefix}-${id}`. */
  testIdPrefix: string;
}) {
  return (
    <ul className="md-analytics-brief">
      {sentences.map((s) => (
        <li key={s.id} className="md-analytics-brief-item" data-testid={`${testIdPrefix}-${s.id}`}>
          <span className={cn("md-analytics-dot", TONE[s.tone] ?? TONE.neutral)} aria-hidden="true" />
          <span className="min-w-0">{s.text}</span>
        </li>
      ))}
    </ul>
  );
}
