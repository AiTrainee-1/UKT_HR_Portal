import { useMemo } from "react";
import { Edit2, Shield, ShieldPlus, Trash2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CircleLoader } from "@/components/ui/CircleLoader";
import type { HrUserItem, Role } from "@/lib/api-client/custom-hooks";
import { levelCounts, roleUsage, type LevelCounts } from "./logic";
import { Chip } from "./parts";

type Props = {
  roles: Role[];
  users: HrUserItem[];
  loading: boolean;
  onCreate: () => void;
  onEdit: (role: Role) => void;
  onDelete: (role: Role) => void;
  /** Jump to the Accounts tab showing only the accounts that have this role. */
  onShowAccounts: (role: Role) => void;
};

/** How much of the portal a role opens up: editable / view-only / hidden, as a bar and in words. */
function AccessBar({ counts, id }: { counts: LevelCounts; id: number }) {
  const pct = (n: number) => (counts.total ? (n / counts.total) * 100 : 0);
  return (
    <div className="min-w-[10rem] space-y-1.5" data-testid={`role-access-${id}`}>
      <div
        className="flex h-2 w-full overflow-hidden rounded-full bg-gray-100"
        role="img"
        aria-label={`${counts.edit} editable, ${counts.view} view only, ${counts.hidden} hidden`}
      >
        <div className="bg-blue-600" style={{ width: `${pct(counts.edit)}%` }} />
        <div className="bg-amber-400" style={{ width: `${pct(counts.view)}%` }} />
      </div>
      <p className="flex flex-wrap gap-x-3 text-[11px] text-gray-500">
        <span className="inline-flex items-center gap-1">
          <i className="h-2 w-2 rounded-full bg-blue-600" /> {counts.edit} edit
        </span>
        <span className="inline-flex items-center gap-1">
          <i className="h-2 w-2 rounded-full bg-amber-400" /> {counts.view} view
        </span>
        <span className="inline-flex items-center gap-1">
          <i className="h-2 w-2 rounded-full bg-gray-300" /> {counts.hidden} hidden
        </span>
      </p>
    </div>
  );
}

export default function RolesTab({ roles, users, loading, onCreate, onEdit, onDelete, onShowAccounts }: Props) {
  const usage = useMemo(() => roleUsage(users), [users]);

  const accountsLink = (r: Role) => {
    const n = usage[r.id] ?? 0;
    return n === 0 ? (
      <span className="text-sm text-gray-400">No accounts</span>
    ) : (
      <button
        type="button"
        onClick={() => onShowAccounts(r)}
        className="inline-flex items-center gap-1.5 text-sm font-semibold text-blue-700 hover:underline"
        title="Show these accounts"
        data-testid={`role-accounts-${r.id}`}
      >
        <Users size={13} /> {n} {n === 1 ? "account" : "accounts"}
      </button>
    );
  };

  const actions = (r: Role) => (
    <div className="flex items-center justify-end gap-0.5">
      <Button
        variant="ghost"
        size="icon"
        onClick={() => onEdit(r)}
        title="Edit role and permissions"
        aria-label={`Edit role ${r.name}`}
        data-testid={`role-edit-${r.name}`}
      >
        <Edit2 size={15} />
      </Button>
      {!r.isSystem && (
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onDelete(r)}
          title="Delete role"
          aria-label={`Delete role ${r.name}`}
          data-testid={`role-delete-${r.name}`}
        >
          <Trash2 size={15} className="text-red-500" />
        </Button>
      )}
    </div>
  );

  return (
    <div className="space-y-3 pt-3">
      <Card className="overflow-hidden rounded-2xl">
        <CardContent className="p-0">
          {loading ? (
            <CircleLoader texts={["UK Textiles", "Account Management", "Loading"]} />
          ) : roles.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-6 py-14 text-center" data-testid="roles-empty">
              <div className="rounded-2xl bg-blue-50 p-4 text-blue-600">
                <Shield size={26} />
              </div>
              <div>
                <p className="font-bold text-gray-900">No roles yet</p>
                <p className="mt-0.5 max-w-sm text-sm text-muted-foreground">
                  A role decides which parts of the portal an account can see and edit. Create one, then give it to the
                  accounts that need it.
                </p>
              </div>
              <Button onClick={onCreate} className="gap-1.5">
                <ShieldPlus size={15} /> Create the first role
              </Button>
            </div>
          ) : (
            <>
              <div className="hidden md:block">
                <Table data-testid="roles-table">
                  <TableHeader>
                    <TableRow>
                      {["Role", "Used by", "Access"].map((h) => (
                        <TableHead key={h} className="text-[11px] font-bold uppercase tracking-wider text-[#006496]/60">
                          {h}
                        </TableHead>
                      ))}
                      <TableHead className="text-right text-[11px] font-bold uppercase tracking-wider text-[#006496]/60">
                        Actions
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {roles.map((r) => (
                      <TableRow key={r.id} data-testid={`role-row-${r.name}`}>
                        <TableCell>
                          <div className="flex items-center gap-3">
                            <div className="rounded-xl bg-blue-50 p-2 text-blue-600">
                              <Shield size={16} />
                            </div>
                            <div className="min-w-0">
                              <p className="flex items-center gap-1.5 font-semibold">
                                {r.name}
                                {r.isSystem && (
                                  <Chip className="border-gray-200 bg-gray-100 text-gray-500">System</Chip>
                                )}
                              </p>
                              <p className="max-w-[20rem] truncate text-xs text-gray-500">
                                {r.description || "No description"}
                              </p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>{accountsLink(r)}</TableCell>
                        <TableCell>
                          <AccessBar counts={levelCounts(r.permissions)} id={r.id} />
                        </TableCell>
                        <TableCell className="text-right">{actions(r)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="divide-y md:hidden" data-testid="roles-cards">
                {roles.map((r) => (
                  <div key={r.id} className="space-y-3 p-4" data-testid={`role-card-${r.name}`}>
                    <div className="flex items-start gap-3">
                      <div className="rounded-xl bg-blue-50 p-2 text-blue-600">
                        <Shield size={16} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="flex flex-wrap items-center gap-1.5 font-semibold">
                          {r.name}
                          {r.isSystem && <Chip className="border-gray-200 bg-gray-100 text-gray-500">System</Chip>}
                        </p>
                        <p className="text-xs text-gray-500">{r.description || "No description"}</p>
                      </div>
                    </div>
                    <AccessBar counts={levelCounts(r.permissions)} id={r.id} />
                    <div className="flex items-center justify-between">
                      {accountsLink(r)}
                      {actions(r)}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
