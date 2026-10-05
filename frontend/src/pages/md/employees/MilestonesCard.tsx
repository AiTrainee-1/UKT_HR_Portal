import type { ComponentType, ReactNode } from "react";
import { Award, Cake, Hourglass } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import SectionCard from "@/components/md/kit/SectionCard";
import { dayShort, num, weekdayShort } from "@/lib/md/format";
import { cn } from "@/lib/utils";
import { whenText, yearsText } from "./logic";
import { PersonAvatar, Unavailable } from "./parts";
import type { EmployeesMilestones, MilestonePerson } from "./types";

function Column({
  icon: Icon,
  title,
  figure,
  tone,
  empty,
  testId,
  children,
}: {
  icon: ComponentType<{ size?: number }>;
  title: string;
  /** The count that heads the column. */
  figure: ReactNode;
  tone: string;
  empty: string;
  testId: string;
  children: ReactNode;
}) {
  const hasRows = Array.isArray(children) ? children.length > 0 : !!children;
  return (
    <div className="min-w-0 rounded-2xl border bg-white/60 p-3" data-testid={testId}>
      <div className="mb-2 flex items-center gap-2">
        <span className={cn("rounded-lg p-1.5", tone)}>
          <Icon size={14} />
        </span>
        <p className="text-[13px] font-bold text-[#1a3a4a]">{title}</p>
        <span className="ml-auto text-[13px] font-black tabular-nums text-[#1a3a4a]">{figure}</span>
      </div>
      {hasRows ? (
        <ul className="space-y-1">{children}</ul>
      ) : (
        <p className="py-4 text-center text-xs text-muted-foreground">{empty}</p>
      )}
    </div>
  );
}

function Row({
  person,
  right,
  onSelect,
}: {
  person: MilestonePerson;
  right: ReactNode;
  onSelect: (employeeId: number) => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(person.id)}
        className="flex w-full items-center gap-2.5 rounded-lg p-1.5 text-left transition-colors hover:bg-[#006496]/[0.06]"
        data-testid={`md-employees-milestone-${person.code}`}
      >
        <PersonAvatar name={person.name} size="sm" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold text-[#1a3a4a]">{person.name}</span>
          <span className="block truncate text-[11px] text-[#006496]/55">
            {[person.designation, person.department].filter(Boolean).join(" · ")}
          </span>
        </span>
        <span className="shrink-0 text-right text-[11px] text-[#006496]/70">{right}</span>
      </button>
    </li>
  );
}

/** The human side: long-service anniversaries, birthdays this week, and probation that is ending. */
export default function MilestonesCard({
  milestones: m,
  question,
  onSelect,
  failed,
}: {
  failed?: boolean;
  milestones: EmployeesMilestones | undefined;
  question: string;
  onSelect: (employeeId: number) => void;
}) {
  return (
    <SectionCard
      title="Moments to mark"
      subtitle="Work anniversaries, birthdays and probation, looking ahead"
      provenance={m?.provenance}
      loading={!m && !failed}
      actions={<AskAiButton question={question} />}
      testId="md-employees-milestones"
    >
      {!m ? (
        <Unavailable />
      ) : (
        <div className="grid grid-cols-1 gap-3 @3xl:grid-cols-3">
          <Column
            icon={Award}
            title={`${m.anniversaries.minYears}+ years of service`}
            figure={num(m.anniversaries.total)}
            tone="bg-amber-100 text-amber-800"
            empty={`No one completes ${m.anniversaries.minYears} or more years in the next ${m.windowDays} days.`}
            testId="md-employees-anniversaries"
          >
            {m.anniversaries.items.map((p) => (
              <Row
                key={p.id}
                person={p}
                onSelect={onSelect}
                right={
                  <>
                    <b className="block text-[12px] text-[#1a3a4a]">{yearsText(p.years)}</b>
                    {whenText(p.date, m.asOf)}
                  </>
                }
              />
            ))}
          </Column>
          <Column
            icon={Cake}
            title={`Birthdays, next ${m.birthdays.windowDays} days`}
            figure={num(m.birthdays.total)}
            tone="bg-rose-100 text-rose-800"
            empty="No birthdays coming up."
            testId="md-employees-birthdays"
          >
            {m.birthdays.items.map((p) => (
              <Row
                key={p.id}
                person={p}
                onSelect={onSelect}
                right={
                  <>
                    <b className="block text-[12px] text-[#1a3a4a]">{dayShort(p.date)}</b>
                    {weekdayShort(p.date)}
                  </>
                }
              />
            ))}
          </Column>
          <Column
            icon={Hourglass}
            title={`Probation ending, next ${m.probation.dueSoonDays} days`}
            figure={num(m.probation.dueSoon)}
            tone="bg-blue-100 text-blue-800"
            empty={
              m.probation.recorded === 0
                ? "No probation end dates are recorded."
                : "No probation ends in the next few weeks."
            }
            testId="md-employees-probation"
          >
            {m.probation.items.map((p) => (
              <Row
                key={p.id}
                person={p}
                onSelect={onSelect}
                right={
                  <>
                    <b className="block text-[12px] text-[#1a3a4a]">{dayShort(p.date)}</b>
                    {whenText(p.date, m.asOf)}
                  </>
                }
              />
            ))}
          </Column>
          {m.probation.pendingConfirmation > 0 && (
            <p
              className="@3xl:col-span-3 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900"
              data-testid="md-employees-unconfirmed"
            >
              <b>{num(m.probation.pendingConfirmation)}</b>{" "}
              {m.probation.pendingConfirmation === 1 ? "person is" : "people are"} past their probation end date without
              a confirmation date on record.
            </p>
          )}
        </div>
      )}
    </SectionCard>
  );
}
