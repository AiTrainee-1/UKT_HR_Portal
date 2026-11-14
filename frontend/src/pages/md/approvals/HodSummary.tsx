import { Lock } from "lucide-react";
import { rightsOff } from "./logic";
import type { Hod } from "./types";

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

/** Who the Department Head is, whom they oversee, and what is waiting for them right now. */
export default function HodSummary({ hod }: { hod: Hod }) {
  const off = rightsOff(hod);
  const oversees = hod.oversees.departments.length
    ? `${hod.oversees.people} people in ${hod.oversees.departments.join(", ")}`
    : `${hod.oversees.people} people`;
  const waiting: [string, number][] = [
    ["Leave", hod.pending.leave],
    ["Permission", hod.pending.permission],
    ["Other", hod.pending.other],
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-4" data-testid="md-approvals-hod">
      <div className="flex min-w-[min(100%,16rem)] flex-1 items-center gap-3">
        <span
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-md-ink text-sm font-extrabold text-md-sand"
          aria-hidden="true"
        >
          {initials(hod.name)}
        </span>
        <div className="min-w-0">
          <p className="break-words text-[15px] font-extrabold text-md-ink">
            {hod.name} <span className="text-xs font-semibold tabular-nums text-md-ink-soft">{hod.code}</span>
          </p>
          <p className="text-xs text-md-ink-soft">
            {[hod.designation, hod.branch].filter(Boolean).join(" · ") || "Department Head"} · oversees {oversees}
          </p>
          {hod.employeeStatus !== "active" && (
            <p className="mt-0.5 text-xs font-semibold text-md-danger-700">
              Their employee record is {hod.employeeStatus}: they cannot sign in to decide these themselves.
            </p>
          )}
        </div>
      </div>
      <dl className="grid w-full grid-cols-4 gap-2 sm:flex sm:w-auto" aria-label="Waiting for this Department Head">
        <div className="rounded-xl bg-md-wine px-3 py-1.5 text-white">
          <dt className="text-[11px] font-bold opacity-80">Waiting</dt>
          <dd className="text-lg font-black tabular-nums leading-6" data-testid="md-approvals-hod-waiting">
            {hod.pending.total}
          </dd>
        </div>
        {waiting.map(([label, n]) => (
          <div key={label} className="rounded-xl bg-white/70 px-3 py-1.5">
            <dt className="text-[11px] font-bold text-md-ink-soft">{label}</dt>
            <dd className="text-lg font-black tabular-nums leading-6 text-md-ink">{n}</dd>
          </div>
        ))}
      </dl>
      {off.length > 0 && (
        <p
          className="flex basis-full items-start gap-1.5 text-xs text-md-ink-soft"
          data-testid="md-approvals-rights-off"
        >
          <Lock size={13} aria-hidden="true" className="mt-px shrink-0" />
          Switched off for {hod.name} in User Management: {off.join(", ")}. Those requests cannot be decided here; HR
          decides them.
        </p>
      )}
    </div>
  );
}
