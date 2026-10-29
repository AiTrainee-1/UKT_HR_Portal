// On-Duty Map: what the shapes on the map mean. Every employee has a colour of their own (their row in the list shows it); the
// shapes are the same for everybody, in neutral grey here.
import { Flag, User } from "lucide-react";

const SWATCH = "inline-flex shrink-0 items-center justify-center rounded-full bg-slate-600 text-white";

export default function PinGuide() {
  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] font-medium text-gray-600"
      data-testid="pin-guide"
    >
      <span className="flex items-center gap-1.5">
        <span className={`${SWATCH} h-5 w-5`} aria-hidden>
          <Flag size={11} />
        </span>
        Start
      </span>
      <span className="flex items-center gap-1.5">
        <span className={`${SWATCH} h-5 w-5`} aria-hidden>
          <User size={11} />
        </span>
        Latest position / end
      </span>
      <span className="flex items-center gap-1.5">
        <span className={`${SWATCH} h-5 w-5 text-[10px] font-bold`} aria-hidden>
          1
        </span>
        Stop
      </span>
      <span className="flex items-center gap-1.5">
        <span className={`${SWATCH} h-6 w-6 text-[11px] font-bold ring-2 ring-slate-300`} aria-hidden>
          2
        </span>
        Long stop (15 min or more)
      </span>
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="inline-block w-6 border-t-[3px] border-dashed border-slate-500" />
        No location
      </span>
      <span className="text-gray-400">One colour per employee.</span>
    </div>
  );
}
