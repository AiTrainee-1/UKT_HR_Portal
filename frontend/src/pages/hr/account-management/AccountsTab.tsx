import { useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Ban,
  CheckCircle2,
  ChevronsUpDown,
  Edit2,
  Globe2,
  MapPin,
  Search,
  Shield,
  Trash2,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CircleLoader } from "@/components/ui/CircleLoader";
import type { Role, HrUserItem } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import {
  NONE,
  NO_FILTERS,
  filterAccounts,
  filtersActive,
  relativeTime,
  sortAccounts,
  summarizeAccounts,
  type AccountFilters,
  type SortDir,
  type SortKey,
} from "./logic";
import { AccountAvatar, Chip, MdChip, StatusDot } from "./parts";

type Props = {
  users: HrUserItem[];
  roles: Role[];
  branches: { id: number; name: string; isHeadOffice?: boolean }[];
  loading: boolean;
  filters: AccountFilters;
  onFilters: (next: AccountFilters) => void;
  onCreate: () => void;
  onEdit: (user: HrUserItem) => void;
  onToggleActive: (user: HrUserItem) => void;
  onDelete: (user: HrUserItem) => void;
  /** The account whose switch is being saved: its buttons are disabled meanwhile. */
  busyId?: number | null;
};

function RoleChip({ name, admin, md }: { name?: string | null; admin?: boolean; md?: boolean }) {
  if (!name && admin) {
    return <Chip className="border-indigo-200 bg-indigo-50 text-indigo-700">Full access</Chip>;
  }
  if (!name && md) {
    return <Chip className="border-[#e0a83a]/50 bg-[#fffaf0] text-[#7a5410]">MD portal only</Chip>;
  }
  return name ? (
    <Chip className="border-blue-200 bg-blue-50 text-blue-700">
      <Shield size={11} /> {name}
    </Chip>
  ) : (
    <Chip className="border-amber-200 bg-amber-50 text-amber-700">No role</Chip>
  );
}

function BranchChip({ name }: { name?: string | null }) {
  return name ? (
    <Chip className="border-teal-200 bg-teal-50 text-teal-700">
      <MapPin size={11} /> {name}
    </Chip>
  ) : (
    <span className="inline-flex items-center gap-1 text-xs text-gray-400">
      <Globe2 size={12} /> All branches
    </span>
  );
}

function Actions({
  user,
  busy,
  onEdit,
  onToggleActive,
  onDelete,
}: {
  user: HrUserItem;
  busy: boolean;
  onEdit: () => void;
  onToggleActive: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center justify-end gap-0.5">
      <Button
        variant="ghost"
        size="icon"
        onClick={onEdit}
        title="Edit account"
        aria-label={`Edit ${user.username}`}
        data-testid={`account-edit-${user.username}`}
      >
        <Edit2 size={15} />
      </Button>
      {!user.isSuperAdmin && (
        <>
          <Button
            variant="ghost"
            size="icon"
            onClick={onToggleActive}
            disabled={busy}
            title={user.isActive ? "Disable login" : "Enable login"}
            aria-label={`${user.isActive ? "Disable" : "Enable"} ${user.username}`}
            data-testid={`account-toggle-${user.username}`}
          >
            {user.isActive ? (
              <Ban size={15} className="text-orange-500" />
            ) : (
              <CheckCircle2 size={15} className="text-emerald-600" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onDelete}
            title="Delete account"
            aria-label={`Delete ${user.username}`}
            data-testid={`account-delete-${user.username}`}
          >
            <Trash2 size={15} className="text-red-500" />
          </Button>
        </>
      )}
    </div>
  );
}

function SortHead({
  label,
  column,
  sort,
  onSort,
  className,
}: {
  label: string;
  column: SortKey;
  sort: { key: SortKey; dir: SortDir };
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  const active = sort.key === column;
  const Icon = !active ? ChevronsUpDown : sort.dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <TableHead
      className={cn("text-[11px] font-bold uppercase tracking-wider text-[#006496]/60", className)}
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className={cn(
          "inline-flex items-center gap-1 rounded uppercase tracking-wider hover:text-[#006496]",
          active && "text-[#006496]",
        )}
        data-testid={`sort-${column}`}
      >
        {label}
        <Icon size={12} className={active ? "" : "opacity-40"} />
      </button>
    </TableHead>
  );
}

export default function AccountsTab({
  users,
  roles,
  branches,
  loading,
  filters,
  onFilters,
  onCreate,
  onEdit,
  onToggleActive,
  onDelete,
  busyId,
}: Props) {
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "username", dir: "asc" });
  const summary = useMemo(() => summarizeAccounts(users), [users]);
  const shown = useMemo(() => sortAccounts(filterAccounts(users, filters), sort.key, sort.dir), [users, filters, sort]);
  const active = filtersActive(filters);
  const onSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));
  const set = (patch: Partial<AccountFilters>) => onFilters({ ...filters, ...patch });

  return (
    <div className="space-y-3 pt-3">
      {/* ── search and filters ── */}
      <div className="space-y-3 rounded-2xl border bg-white p-3">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <Input
              value={filters.query}
              onChange={(e) => set({ query: e.target.value })}
              placeholder="Search by username, name, email, role or branch"
              aria-label="Search accounts"
              className="h-10 pl-9 pr-9"
              data-testid="account-search"
            />
            {filters.query && (
              <button
                type="button"
                onClick={() => set({ query: "" })}
                aria-label="Clear search"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 hover:text-gray-700"
              >
                <X size={14} />
              </button>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2 lg:flex">
            <Select value={filters.role} onValueChange={(v) => set({ role: v })}>
              <SelectTrigger className="h-10 lg:w-44" aria-label="Filter by role" data-testid="filter-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All roles</SelectItem>
                <SelectItem value={NONE}>No role</SelectItem>
                {roles.map((r) => (
                  <SelectItem key={r.id} value={String(r.id)}>
                    {r.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={filters.branch} onValueChange={(v) => set({ branch: v })}>
              <SelectTrigger className="h-10 lg:w-44" aria-label="Filter by branch" data-testid="filter-branch">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All branches</SelectItem>
                <SelectItem value={NONE}>Company-wide only</SelectItem>
                {branches.map((b) => (
                  <SelectItem key={b.id} value={String(b.id)}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <PillTabs
            size="sm"
            items={[
              { value: "all", label: "All", count: summary.total },
              { value: "active", label: "Active", count: summary.active },
              { value: "disabled", label: "Disabled", count: summary.disabled },
            ]}
            value={filters.status}
            onChange={(v) => set({ status: v as AccountFilters["status"] })}
          />
          <p className="text-xs text-gray-500" data-testid="account-count">
            Showing <b>{shown.length}</b> of {users.length}
            {active && (
              <button
                type="button"
                onClick={() => onFilters(NO_FILTERS)}
                className="ml-2 font-semibold text-blue-600 hover:underline"
                data-testid="account-clear-filters"
              >
                Clear filters
              </button>
            )}
          </p>
        </div>
      </div>

      {/* ── the list ── */}
      <Card className="overflow-hidden rounded-2xl">
        <CardContent className="p-0">
          {loading ? (
            <CircleLoader texts={["UK Textiles", "Account Management", "Loading"]} />
          ) : users.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-6 py-14 text-center" data-testid="accounts-empty">
              <div className="rounded-2xl bg-blue-50 p-4 text-blue-600">
                <Users size={26} />
              </div>
              <div>
                <p className="font-bold text-gray-900">No accounts yet</p>
                <p className="mt-0.5 max-w-sm text-sm text-muted-foreground">
                  Create a login for each person who should use the HR portal, then give it a role that decides what it
                  can see and edit.
                </p>
              </div>
              <Button onClick={onCreate} className="gap-1.5">
                <UserPlus size={15} /> Create the first account
              </Button>
            </div>
          ) : shown.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-6 py-14 text-center" data-testid="accounts-no-match">
              <div className="rounded-2xl bg-gray-100 p-4 text-gray-500">
                <Search size={26} />
              </div>
              <div>
                <p className="font-bold text-gray-900">No account matches</p>
                <p className="mt-0.5 text-sm text-muted-foreground">Try fewer words, or clear the filters.</p>
              </div>
              <Button variant="outline" onClick={() => onFilters(NO_FILTERS)}>
                Clear filters
              </Button>
            </div>
          ) : (
            <>
              {/* wide screens: a table */}
              <div className="hidden md:block">
                <Table data-testid="accounts-table">
                  <TableHeader>
                    <TableRow>
                      <SortHead label="Account" column="username" sort={sort} onSort={onSort} />
                      <SortHead label="Role" column="role" sort={sort} onSort={onSort} />
                      <SortHead label="Branch" column="branch" sort={sort} onSort={onSort} />
                      <SortHead label="Status" column="status" sort={sort} onSort={onSort} />
                      <SortHead label="Last login" column="lastLogin" sort={sort} onSort={onSort} />
                      <TableHead className="text-right text-[11px] font-bold uppercase tracking-wider text-[#006496]/60">
                        Actions
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {shown.map((u) => (
                      <TableRow
                        key={u.id}
                        className={cn(!u.isActive && "bg-gray-50/60")}
                        data-testid={`account-row-${u.username}`}
                        data-active={u.isActive}
                      >
                        <TableCell>
                          <div className="flex items-center gap-3">
                            <AccountAvatar
                              username={u.username}
                              fullName={u.fullName}
                              disabled={!u.isActive}
                              md={u.isMd}
                            />
                            <div className="min-w-0">
                              <p
                                className={cn(
                                  "flex items-center gap-1.5 font-semibold",
                                  !u.isActive && "text-gray-500",
                                )}
                              >
                                {u.username}
                                {u.isSuperAdmin && (
                                  <Chip className="border-blue-200 bg-blue-50 text-blue-700">Admin</Chip>
                                )}
                                {u.isMd && <MdChip label="Managing Director" />}
                              </p>
                              <p className="max-w-[16rem] truncate text-xs text-gray-500">
                                {[u.fullName, u.email].filter(Boolean).join(" · ") || "No name or email"}
                              </p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <RoleChip name={u.roleName} admin={u.isSuperAdmin} md={u.isMd} />
                        </TableCell>
                        <TableCell>
                          <BranchChip name={u.branchName} />
                        </TableCell>
                        <TableCell>
                          <StatusDot active={u.isActive} />
                        </TableCell>
                        <TableCell
                          className="whitespace-nowrap text-xs text-gray-500"
                          title={u.lastLogin ? new Date(u.lastLogin).toLocaleString() : "Has never signed in"}
                        >
                          {relativeTime(u.lastLogin)}
                        </TableCell>
                        <TableCell className="text-right">
                          <Actions
                            user={u}
                            busy={busyId === u.id}
                            onEdit={() => onEdit(u)}
                            onToggleActive={() => onToggleActive(u)}
                            onDelete={() => onDelete(u)}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* phones: a card for each account */}
              <div className="divide-y md:hidden" data-testid="accounts-cards">
                {shown.map((u) => (
                  <div
                    key={u.id}
                    className={cn("space-y-3 p-4", !u.isActive && "bg-gray-50/60")}
                    data-testid={`account-card-${u.username}`}
                  >
                    <div className="flex items-start gap-3">
                      <AccountAvatar
                        username={u.username}
                        fullName={u.fullName}
                        disabled={!u.isActive}
                        md={u.isMd}
                        size="lg"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="flex flex-wrap items-center gap-1.5 font-semibold">
                          {u.username}
                          {u.isSuperAdmin && <Chip className="border-blue-200 bg-blue-50 text-blue-700">Admin</Chip>}
                          {u.isMd && <MdChip label="Managing Director" />}
                        </p>
                        <p className="truncate text-xs text-gray-500">
                          {[u.fullName, u.email].filter(Boolean).join(" · ") || "No name or email"}
                        </p>
                      </div>
                      <StatusDot active={u.isActive} />
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <RoleChip name={u.roleName} admin={u.isSuperAdmin} md={u.isMd} />
                      <BranchChip name={u.branchName} />
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-gray-500">Last login: {relativeTime(u.lastLogin)}</span>
                      <Actions
                        user={u}
                        busy={busyId === u.id}
                        onEdit={() => onEdit(u)}
                        onToggleActive={() => onToggleActive(u)}
                        onDelete={() => onDelete(u)}
                      />
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
