import { ArrowRight, ArrowUpRight, Flag } from "lucide-react";
import { formatMoney } from "../career/common";
import { formatDate } from "../career/dates";
import type { SalaryStep } from "./logic";

/** One employee's salary path, newest first, ending with the salary they started on when it is known. */
export default function SalaryTimeline({ steps, startSalary }: { steps: SalaryStep[]; startSalary?: number | null }) {
  return (
    <ol className="relative space-y-4 border-l-2 border-green-100 pl-5" data-testid="salary-timeline">
      {steps.map((s) => (
        <li key={s.id} className="relative" data-testid={`salary-step-${s.id}`}>
          <span className="absolute -left-[1.85rem] top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-green-500 text-white ring-4 ring-white">
            <ArrowUpRight size={11} />
          </span>
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="text-xs font-semibold text-gray-500">{formatDate(s.date)}</p>
              <p className="flex flex-wrap items-center gap-x-2 text-sm">
                <span className="text-gray-500">{formatMoney(s.from)}</span>
                <ArrowRight size={13} className="shrink-0 text-green-500" aria-label="became" />
                <span className="font-semibold text-gray-900">{formatMoney(s.to)}</span>
              </p>
              {s.notes && <p className="text-xs text-gray-500">{s.notes}</p>}
              {s.addedBy && <p className="text-[11px] text-gray-400">Recorded by {s.addedBy}</p>}
            </div>
            <div className="shrink-0 text-right">
              <p className="text-sm font-black text-green-600">+{s.percent}%</p>
              <p className="text-[11px] font-semibold text-green-700/70">+{formatMoney(s.amount)}</p>
            </div>
          </div>
        </li>
      ))}
      {startSalary != null && startSalary > 0 && (
        <li className="relative" data-testid="salary-start">
          <span className="absolute -left-[1.85rem] top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-gray-300 text-white ring-4 ring-white">
            <Flag size={10} />
          </span>
          <p className="text-sm text-gray-700">
            Started on <span className="font-semibold">{formatMoney(startSalary)}</span>
          </p>
        </li>
      )}
    </ol>
  );
}
