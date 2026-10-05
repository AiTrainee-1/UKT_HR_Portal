import { num } from "@/lib/md/format";
import { daysSinceText, plural, whenText } from "./logic";
import { Chip, ListHeading, PersonCell } from "./parts";
import type { ActivitySignIns } from "./types";

const none = <p className="text-xs text-muted-foreground">None.</p>;

/** The security signals beside the people table: failed attempts, devices used for the first time, sessions open at the
 *  same time, and accounts nobody signs in to. Short lists: the full detail is one question to the assistant away. */
export default function SecuritySignals({ data }: { data: ActivitySignIns }) {
  const failed = data.failed.accounts.slice(0, 5);
  const devices = data.newDevices.slice(0, 5);
  return (
    <div className="space-y-5" data-testid="md-activity-security">
      <section>
        <ListHeading>Failed attempts</ListHeading>
        {failed.length === 0 ? (
          none
        ) : (
          <ul className="space-y-2">
            {failed.map((f) => (
              <li key={f.userName} className="flex items-center justify-between gap-2 text-xs">
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 text-[13px] font-semibold text-[#1a3a4a]">
                    <span className="truncate">{f.userName}</span>
                    {!f.knownAccount && (
                      <Chip className="border-slate-300 bg-slate-100 text-slate-700">Not an account</Chip>
                    )}
                  </p>
                  <p className="text-[11px] text-[#006496]/55">Last: {whenText(f.lastAt)}</p>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  {f.lockedOut > 0 && <Chip className="border-red-200 bg-red-100 text-red-800">Locked out</Chip>}
                  <Chip className="border-amber-200 bg-amber-100 text-amber-800">
                    {num(f.failures)} {plural(f.failures, "try", "tries")}
                  </Chip>
                </div>
              </li>
            ))}
          </ul>
        )}
        {data.failed.blockedAttempts > 0 && (
          <p className="mt-2 text-[11px] text-[#006496]/60">
            {num(data.failed.blockedAttempts)} further {plural(data.failed.blockedAttempts, "try", "tries")} while a
            username was locked.
          </p>
        )}
      </section>

      <section>
        <ListHeading>New devices</ListHeading>
        {devices.length === 0 ? (
          none
        ) : (
          <ul className="space-y-2">
            {devices.map((d) => (
              <li key={`${d.userName}-${d.device}`} className="flex items-center justify-between gap-2">
                <PersonCell name={d.userName} role={`${d.device} · ${whenText(d.at)}`} privileged={d.privileged} />
                {d.privileged && <Chip className="border-amber-200 bg-amber-100 text-amber-800">Privileged</Chip>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <ListHeading>Open at the same time</ListHeading>
        <p className="text-xs text-[#1a3a4a]">
          <b>{num(data.concurrent.overlappingSignIns)}</b> {plural(data.concurrent.overlappingSignIns, "sign-in")} began
          while the same account was already signed in
          {data.concurrent.accounts.length > 0 && (
            <> ({data.concurrent.accounts.map((a) => `${a.userName} ${a.overlapping}`).join(", ")})</>
          )}
          . Signed in right now: <b>{num(data.concurrent.liveNow.sessions)}</b>{" "}
          {plural(data.concurrent.liveNow.sessions, "session")}
          {data.concurrent.severalNow.length > 0 && (
            <>, {data.concurrent.severalNow.map((a) => `${a.userName} on ${a.sessions}`).join(", ")}</>
          )}
          .
        </p>
      </section>

      <section>
        <ListHeading>No sign-in for {data.dormant.days}+ days</ListHeading>
        {data.dormant.accounts.length === 0 ? (
          none
        ) : (
          <ul className="space-y-2">
            {data.dormant.accounts.map((a) => (
              <li key={a.userName} className="flex items-center justify-between gap-2">
                <PersonCell name={a.userName} role={a.role} />
                <span className="shrink-0 text-xs text-[#006496]/65">
                  {a.daysSince == null ? "Never signed in" : daysSinceText(a.daysSince)}
                </span>
              </li>
            ))}
          </ul>
        )}
        {data.dormant.count > data.dormant.accounts.length && (
          <p className="mt-2 text-[11px] text-[#006496]/60">
            And {num(data.dormant.count - data.dormant.accounts.length)} more.
          </p>
        )}
      </section>
    </div>
  );
}
