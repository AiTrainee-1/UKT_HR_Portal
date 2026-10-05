import DataTable, { type Column } from "@/components/md/kit/DataTable";
import { num } from "@/lib/md/format";
import { daysSinceText, whenText } from "./logic";
import { Chip, PersonCell } from "./parts";
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
    cell: (a) => <b className="tabular-nums">{num(a.signIns)}</b>,
    sortValue: (a) => a.signIns,
  },
  {
    key: "devices",
    header: "Devices",
    cell: (a) =>
      a.devices.length === 0 ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        <div className="flex flex-wrap gap-1">
          {a.devices.slice(0, 2).map((d) => (
            <Chip key={d} className="border-slate-200 bg-slate-50 text-slate-700">
              {d}
            </Chip>
          ))}
          {a.devices.length > 2 && (
            <Chip className="border-slate-200 bg-slate-50 text-slate-700">+{a.devices.length - 2}</Chip>
          )}
        </div>
      ),
  },
  {
    key: "last",
    header: "Last sign-in",
    cell: (a) => (
      <div className="whitespace-nowrap text-xs text-[#1a3a4a]">
        <p>{whenText(a.lastSignIn)}</p>
        <p className="text-[11px] text-[#006496]/55">{daysSinceText(a.daysSince)}</p>
      </div>
    ),
    sortValue: (a) => a.lastSignIn,
  },
  {
    key: "flags",
    header: "Flags",
    cell: (a) => {
      const flags = [
        a.newDevices > 0 && { text: "New device", cls: "border-amber-200 bg-amber-100 text-amber-800" },
        a.overlapping > 0 && { text: "Open twice", cls: "border-blue-200 bg-blue-50 text-blue-800" },
        a.dormant && { text: "Dormant", cls: "border-slate-300 bg-slate-100 text-slate-700" },
      ].filter((f): f is { text: string; cls: string } => Boolean(f));
      return flags.length === 0 ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        <div className="flex flex-wrap gap-1">
          {flags.map((f) => (
            <Chip key={f.text} className={f.cls}>
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
