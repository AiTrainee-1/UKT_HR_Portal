import { NoteBanner } from "@/components/md/kit/states";

/** The caveats behind the figures: how many people scan, how many breaks could not be measured, today being partial.
 *  Always shown when the server has something to say, because a number is only as good as the scans behind it. */
export default function CoverageNote({ notes }: { notes: string[] | undefined }) {
  if (!notes || notes.length === 0) return null;
  return (
    <NoteBanner>
      <div data-testid="md-tea-break-coverage">
        <p className="font-semibold">About these figures</p>
        <ul className="mt-1 list-disc space-y-1 pl-4">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </div>
    </NoteBanner>
  );
}
