import { useMemo, useState } from "react";
import { Link } from "wouter";
import {
  Activity,
  Ban,
  Briefcase,
  CheckCircle2,
  ClipboardList,
  Edit2,
  Globe2,
  Lock,
  MapPin,
  Search,
  Shield,
  SlidersHorizontal,
  UserPlus,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CircleLoader } from "@/components/ui/CircleLoader";
import type { HrUserItem, Role } from "@/lib/api-client/custom-hooks";
import { ASSISTANT_LOCKED, APPROVAL_LABEL, CATEGORY_LABEL, overrideCount } from "@/lib/hr-access";
import { cn } from "@/lib/utils";
import { CATEGORY_PURPOSE, accountsOf, relativeTime, sortAccounts, type StaffCategory } from "./logic";
import { AccountAvatar, Chip, StatusDot } from "./parts";

type Props = {
  category: StaffCategory;
  users: HrUserItem[];
  roles: Role[];
  loading: boolean;
  onCreate: () => void;
  onEdit: (user: HrUserItem) => void;
  onToggleActive: (user: HrUserItem) => void;
  busyId?: number | null;
};

/** "Follows role" or "3 custom": whether this person has access of their own on top of the role. */
function AccessChip({ user }: { user: HrUserItem }) {
  const n = overrideCount(user.permissionOverrides);
  return n === 0 ? (
    <span className="text-xs text-gray-400">Follows role</span>
  ) : (
    <Chip className="border-blue-200 bg-blue-50 text-blue-700">
      <SlidersHorizontal size={11} /> {n} custom
    </Chip>
  );
}

function activityHref(category: StaffCategory, user: HrUserItem) {
  return `/hr/assistant-activity?${category === "hr_manager" ? "category=hr_manager&" : ""}accountId=${user.id}`;
}

function RowActions({
  category,
  user,
  busy,
  onEdit,
  onToggleActive,
}: {
  category: StaffCategory;
  user: HrUserItem;
  busy: boolean;
  onEdit: () => void;
  onToggleActive: () => void;
}) {
  return (
    <div className="flex items-center justify-end gap-0.5">
      <Button variant="ghost" size="icon" asChild>
        <Link
          href={activityHref(category, user)}
          title="See what this person did"
          aria-label={`Activity of ${user.username}`}
          data-testid={`cat-activity-${user.username}`}
        >
          <Activity size={15} className="text-indigo-600" />
        </Link>
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={onEdit}
        title="Edit account and access"
        aria-label={`Edit ${user.username}`}
        data-testid={`cat-edit-${user.username}`}
      >
        <Edit2 size={15} />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={onToggleActive}
        disabled={busy}
        title={user.isActive ? "Deactivate login" : "Activate login"}
        aria-label={`${user.isActive ? "Disable" : "Enable"} ${user.username}`}
        data-testid={`cat-toggle-${user.username}`}
      >
        {user.isActive ? (
          <Ban size={15} className="text-orange-500" />
        ) : (
          <CheckCircle2 size={15} className="text-emerald-600" />
        )}
      </Button>
    </div>
  );
}

/** The HR Manager / HR Assistant tab of Account Management: the accounts of one category, managed by the Super Admin. */
export default function CategoryTab({
  category,
  users,
  roles,
  loading,
  onCreate,
  onEdit,
  onToggleActive,
  busyId,
}: Props) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | "active" | "disabled">("all");
  const mine = useMemo(() => accountsOf(users, category), [users, category]);
  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const list = mine.filter((u) => {
      if (status === "active" && !u.isActive) return false;
      if (status === "disabled" && u.isActive) return false;
      const hay = [u.username, u.fullName, u.email, u.roleName, u.branchName].filter(Boolean).join(" ").toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    return sortAccounts(list, "username", "asc");
  }, [mine, query, status]);
  const label = CATEGORY_LABEL[category];
  const active = mine.filter((u) => u.isActive).length;
  const ownRoles = roles.filter((r) => r.category === category).length;
  const Icon = category === "hr_manager" ? Briefcase : ClipboardList;
  const tone = category === "hr_manager" ? "bg-teal-50 text-teal-800" : "bg-violet-50 text-violet-800";

  return (
    <div className="space-y-3 pt-3" data-testid={`category-tab-${category}`}>
      {/* ── what this category is ── */}
      <div className={cn("flex flex-col gap-3 rounded-2xl p-4 sm:flex-row sm:items-start", tone)}>
        <div className="rounded-xl bg-white/70 p-2.5">
          <Icon size={18} />
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="text-sm font-bold">
            {label}s · {mine.length} {mine.length === 1 ? "account" : "accounts"} ({active} active)
          </p>
          <p className="text-xs leading-relaxed opacity-80">{CATEGORY_PURPOSE[category]}</p>
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            <Chip className="border-white/60 bg-white/70 text-current">
              <Shield size={11} /> {ownRoles} {ownRoles === 1 ? "role" : "roles"} made for {label}s
            </Chip>
            {category === "hr_assistant" &&
              Object.keys(ASSISTANT_LOCKED).map((k) => (
                <Chip key={k} className="border-white/60 bg-white/70 text-current">
                  <Lock size={11} /> Never approves {APPROVAL_LABEL[k]?.toLowerCase()}
                </Chip>
              ))}
            <Link
              href={category === "hr_manager" ? "/hr/assistant-activity?category=hr_manager" : "/hr/assistant-activity"}
              className="inline-flex items-center gap-1 text-[11px] font-semibold underline"
              data-testid={`category-activity-link-${category}`}
            >
              <Activity size={11} /> {category === "hr_manager" ? "HR Manager activity" : "HR Assistant activity"}
            </Link>
          </div>
        </div>
      </div>

      {/* ── search ── */}
      <div className="flex flex-col gap-2 rounded-2xl border bg-white p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative flex-1">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${label}s by username, name, role or branch`}
            aria-label={`Search ${label}s`}
            className="h-10 pl-9 pr-9"
            data-testid={`category-search-${category}`}
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 hover:text-gray-700"
            >
              <X size={14} />
            </button>
          )}
        </div>
        <PillTabs
          size="sm"
          items={[
            { value: "all", label: "All", count: mine.length },
            { value: "active", label: "Active", count: active },
            { value: "disabled", label: "Disabled", count: mine.length - active },
          ]}
          value={status}
          onChange={(v) => setStatus(v as typeof status)}
        />
      </div>

      <Card className="overflow-hidden rounded-2xl">
        <CardContent className="p-0">
          {loading ? (
            <CircleLoader texts={["UK Textiles", "Account Management", "Loading"]} />
          ) : mine.length === 0 ? (
            <div
              className="flex flex-col items-center gap-3 px-6 py-14 text-center"
              data-testid={`category-empty-${category}`}
            >
              <div className={cn("rounded-2xl p-4", tone)}>
                <Icon size={26} />
              </div>
              <div>
                <p className="font-bold text-gray-900">No {label} accounts yet</p>
                <p className="mt-0.5 max-w-sm text-sm text-muted-foreground">
                  Create a login for each {label}. It starts from a role made for {label}s, and you can change pages and
                  approvals for each person.
                </p>
              </div>
              <Button onClick={onCreate} className="gap-1.5">
                <UserPlus size={15} /> Create the first {label}
              </Button>
            </div>
          ) : shown.length === 0 ? (
            <div className="px-6 py-12 text-center text-sm text-muted-foreground">No {label} matches.</div>
          ) : (
            <>
              <div className="hidden md:block">
                <Table data-testid={`category-table-${category}`}>
                  <TableHeader>
                    <TableRow>
                      {["Account", "Role", "Access", "Branch", "Status", "Last login"].map((h) => (
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
                    {shown.map((u) => (
                      <TableRow
                        key={u.id}
                        className={cn(!u.isActive && "bg-gray-50/60")}
                        data-testid={`cat-row-${u.username}`}
                        data-active={u.isActive}
                      >
                        <TableCell>
                          <div className="flex items-center gap-3">
                            <AccountAvatar username={u.username} fullName={u.fullName} disabled={!u.isActive} />
                            <div className="min-w-0">
                              <p className={cn("font-semibold", !u.isActive && "text-gray-500")}>{u.username}</p>
                              <p className="max-w-[14rem] truncate text-xs text-gray-500">
                                {[u.fullName, u.email].filter(Boolean).join(" · ") || "No name or email"}
                              </p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          {u.roleName ? (
                            <Chip className="border-blue-200 bg-blue-50 text-blue-700">
                              <Shield size={11} /> {u.roleName}
                            </Chip>
                          ) : (
                            <Chip className="border-amber-200 bg-amber-50 text-amber-700">No role</Chip>
                          )}
                        </TableCell>
                        <TableCell>
                          <AccessChip user={u} />
                        </TableCell>
                        <TableCell>
                          {u.branchName ? (
                            <Chip className="border-teal-200 bg-teal-50 text-teal-700">
                              <MapPin size={11} /> {u.branchName}
                            </Chip>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-xs text-gray-400">
                              <Globe2 size={12} /> All branches
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          <StatusDot active={u.isActive} />
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-gray-500">
                          {relativeTime(u.lastLogin)}
                        </TableCell>
                        <TableCell className="text-right">
                          <RowActions
                            category={category}
                            user={u}
                            busy={busyId === u.id}
                            onEdit={() => onEdit(u)}
                            onToggleActive={() => onToggleActive(u)}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div className="divide-y md:hidden" data-testid={`category-cards-${category}`}>
                {shown.map((u) => (
                  <div
                    key={u.id}
                    className={cn("space-y-3 p-4", !u.isActive && "bg-gray-50/60")}
                    data-testid={`cat-card-${u.username}`}
                  >
                    <div className="flex items-start gap-3">
                      <AccountAvatar username={u.username} fullName={u.fullName} disabled={!u.isActive} size="lg" />
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold">{u.username}</p>
                        <p className="truncate text-xs text-gray-500">
                          {[u.fullName, u.email].filter(Boolean).join(" · ") || "No name or email"}
                        </p>
                      </div>
                      <StatusDot active={u.isActive} />
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {u.roleName ? (
                        <Chip className="border-blue-200 bg-blue-50 text-blue-700">
                          <Shield size={11} /> {u.roleName}
                        </Chip>
                      ) : (
                        <Chip className="border-amber-200 bg-amber-50 text-amber-700">No role</Chip>
                      )}
                      <AccessChip user={u} />
                      <span className="text-xs text-gray-500">{u.branchName ?? "All branches"}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-gray-500">Last login: {relativeTime(u.lastLogin)}</span>
                      <RowActions
                        category={category}
                        user={u}
                        busy={busyId === u.id}
                        onEdit={() => onEdit(u)}
                        onToggleActive={() => onToggleActive(u)}
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
