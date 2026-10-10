import DataTable, { type Column } from "@/components/md/kit/DataTable";
import { num } from "@/lib/md/format";
import { daysSinceText, whenText } from "./logic";
import { Chip, PersonCell, type ChipTone } from "./parts";
import type { SignInAccount } from "./types";

const COLUMNS: Column<SignInAccount>[] = [
  {
    key: "person",
    header: "Person",
    cell: (a) => (
      <PersonCell
        name={a.userName}
        role={a.enabled ? a.role : `${a.role ?? "Account"} · disabled`}
        privileged={a.privileged}
      />
    ),
    sortValue: (a) => a.userName.toLowerCase(),
  },
  {
    key: "signIns",
    header: "Sign-ins",
    align: "right",
    cell: (a) => <b className="tabular-nums text-md-ink">{num(a.signIns)}</b>,
    sortValue: (a) => a.signIns,
  },
  {
    key: "devices",
    header: "Devices",
    cell: (a) =>
      a.devices.length === 0 ? (
        <span className="text-md-ink-soft">—</span>
      ) : (
        <div className="flex flex-wrap gap-1">
          {a.devices.slice(0, 2).map((d) => (
            <Chip key={d}>{d}</Chip>
          ))}
          {a.devices.length > 2 && <Chip>+{a.devices.length - 2}</Chip>}
        </div>
      ),
  },
  {
    key: "last",
    header: "Last sign-in",
    cell: (a) => (
      <div className="whitespace-nowrap text-xs text-md-ink">
        <p>{whenText(a.lastSignIn)}</p>
        <p className="text-[11px] text-md-ink-soft">{daysSinceText(a.daysSince)}</p>
      </div>
    ),
    sortValue: (a) => a.lastSignIn,
  },
  {
    key: "flags",
    header: "Flags",
    cell: (a) => {
      const flags = [
        a.newDevices > 0 && { text: "New device", tone: "warning" as ChipTone },
        a.overlapping > 0 && { text: "Open twice", tone: "info" as ChipTone },
        a.dormant && { text: "Dormant", tone: "neutral" as ChipTone },
      ].filter((f): f is { text: string; tone: ChipTone } => Boolean(f));
      return flags.length === 0 ? (
        <span className="text-md-ink-soft">—</span>
      ) : (
        <div className="flex flex-wrap gap-1">
          {flags.map((f) => (
            <Chip key={f.text} tone={f.tone}>
              {f.text}
            </Chip>
          ))}
        </div>
      );
    },
  },
];

/** Every enabled account (and anyone who signed in), most sign-ins first: devices, last sign-in and what looks off. */
export default function SignInPeople({ accounts }: { accounts: SignInAccount[] }) {
  return (
    <DataTable
      columns={COLUMNS}
      rows={accounts}
      rowKey={(a) => a.userName}
      initialSort={{ key: "signIns", dir: "desc" }}
      pageSize={5}
      dense
      empty="No accounts."
      testId="md-activity-signin-table"
    />
  );
}
