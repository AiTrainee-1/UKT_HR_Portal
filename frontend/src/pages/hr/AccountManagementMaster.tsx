import { useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, ShieldAlert, Eye, EyeOff, CheckCircle2, XCircle, Search,
} from "lucide-react";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { CircleLoader } from "@/components/ui/CircleLoader";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import {
  useMasterHrUsers, useUpdateMasterFlags,
  getMasterHrUsersQueryKey, getListHrUsersQueryKey,
  type HrUserItem,
} from "@/lib/api-client/custom-hooks";

/**
 * Account Management → Master
 *
 * A control panel over the accounts the normal Account Management page
 * lists -deliberately NOT a second place to administer users. Creating
 * accounts, editing them, assigning roles and setting passwords all stay on
 * /hr/account-management; this page only decides which of those accounts are
 * visible there, and which hold the CO capability.
 *
 * Restricted to the single ADMIN_USERNAME account (not merely any super
 * admin) -otherwise one admin hiding an account from another would be
 * cosmetic, since the other could just come here and unhide it.
 */
export default function AccountManagementMaster() {
  const { toast } = useToast();
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  /** ids with a toggle in flight, so only that row's switches are disabled. */
  const [busy, setBusy] = useState<Set<number>>(new Set());

  const { data: users, isLoading, error } = useMasterHrUsers({
    // The API is the real gate; skipping the call for everyone else avoids
    // a guaranteed 403 in the console on the way to the redirect.
    enabled: !!user?.isMasterAdmin,
  });
  const updateFlags = useUpdateMasterFlags();

  // Belt-and-braces: App.tsx already redirects, this covers a direct render.
  if (user && !user.isMasterAdmin) {
    return (
      <HrLayout>
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <ShieldAlert size={34} className="text-red-500" />
          <h2 className="mt-3 text-xl font-black text-gray-900">Master administrator only</h2>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            This page is limited to the designated administrator account. Your
            account can still use Account Management normally.
          </p>
        </div>
      </HrLayout>
    );
  }

  const applyChange = async (
    u: HrUserItem,
    patch: { isHidden?: boolean; features?: Record<string, boolean> },
    successTitle: string,
  ) => {
    setBusy((b) => new Set(b).add(u.id));
    try {
      await updateFlags.mutateAsync({ id: u.id, ...patch });
      // Both lists change meaning: this one shows the new flag, and the
      // normal Account Management list gains or loses the row.
      queryClient.invalidateQueries({ queryKey: getMasterHrUsersQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListHrUsersQueryKey() });
      toast({ title: successTitle });
    } catch (e: any) {
      toast({
        title: "Could not update account",
        description: e?.message,
        variant: "destructive",
      });
    } finally {
      setBusy((b) => {
        const next = new Set(b);
        next.delete(u.id);
        return next;
      });
    }
  };

  const q = search.trim().toLowerCase();
  const rows = (users ?? []).filter(
    (u) =>
      !q ||
      u.username.toLowerCase().includes(q) ||
      (u.fullName ?? "").toLowerCase().includes(q) ||
      (u.roleName ?? "").toLowerCase().includes(q),
  );
  const hiddenCount = (users ?? []).filter((u) => u.isHidden).length;

  return (
    <HrLayout>
      <div className="space-y-5">
        <button
          onClick={() => navigate("/hr/account-management")}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft size={15} /> Back to Account Management
        </button>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-2xl font-black text-gray-900">
              <ShieldAlert className="text-amber-600" size={22} />
              Master Controls
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Choose which accounts appear on Account Management, and grant the
              CO capability. Accounts are created and edited there, not here.
            </p>
          </div>
          <div className="relative w-full sm:w-72">
            <Search
              size={15}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Username, name or role…"
              className="pl-9"
            />
          </div>
        </div>

        {/* Hiding an account does not disable it -that distinction is the
            whole point of this page, so it is stated rather than implied. */}
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <strong className="font-semibold">Hidden accounts stay fully active.</strong>{" "}
          They can still sign in, keep every permission their role grants, and
          appear in Activity Logs — they are only removed from the Account
          Management list. To disable an account, use Account Management.
          {hiddenCount > 0 && (
            <> Currently hidden: <strong>{hiddenCount}</strong>.</>
          )}
        </div>

        <Card className="overflow-hidden rounded-2xl">
          <CardContent className="p-0">
            {isLoading ? (
              <CircleLoader texts={["UK Textiles", "Master Controls", "Loading"]} />
            ) : error ? (
              <p className="py-16 text-center text-sm text-muted-foreground">
                Could not load accounts. {(error as any)?.message ?? ""}
              </p>
            ) : rows.length === 0 ? (
              <p className="py-16 text-center text-sm text-muted-foreground">
                {q ? `No account matches “${search}”.` : "No accounts yet."}
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    {["Username", "Full Name", "Role", "Branch", "Status"].map((h) => (
                      <TableHead
                        key={h}
                        className="text-[11px] font-bold uppercase tracking-wider text-[#006496]/50"
                      >
                        {h}
                      </TableHead>
                    ))}
                    <TableHead className="text-center text-[11px] font-bold uppercase tracking-wider text-[#006496]/50">
                      Show on Account Management
                    </TableHead>
                    <TableHead className="text-center text-[11px] font-bold uppercase tracking-wider text-[#006496]/50">
                      CO
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((u) => {
                    const rowBusy = busy.has(u.id);
                    const co = !!u.masterFeatures?.co;
                    return (
                      <TableRow key={u.id} className={u.isHidden ? "bg-gray-50/70" : undefined}>
                        <TableCell className="font-medium">
                          {u.username}
                          {u.isSuperAdmin && (
                            <Badge className="ml-2 border-blue-200 bg-blue-50 text-[10px] text-blue-600">
                              Admin
                            </Badge>
                          )}
                          {u.isHidden && (
                            <Badge className="ml-2 gap-1 border-gray-200 bg-gray-100 text-[10px] text-gray-600">
                              <EyeOff size={10} /> Hidden
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-sm text-gray-500">{u.fullName || "—"}</TableCell>
                        <TableCell className="text-sm text-gray-500">{u.roleName || "—"}</TableCell>
                        <TableCell className="text-sm text-gray-500">
                          {u.branchName ? (
                            <Badge
                              variant="outline"
                              className="border-teal-200 bg-teal-50 text-[10px] text-teal-700"
                            >
                              {u.branchName}
                            </Badge>
                          ) : (
                            <span className="text-xs text-gray-400">All branches</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {u.isActive ? (
                            <Badge className="gap-1 border-green-200 bg-green-50 text-xs text-green-600">
                              <CheckCircle2 size={11} /> Active
                            </Badge>
                          ) : (
                            <Badge className="gap-1 border-red-200 bg-red-50 text-xs text-red-600">
                              <XCircle size={11} /> Disabled
                            </Badge>
                          )}
                        </TableCell>

                        {/* Switch reads as "visible", not "hidden" -a switch
                            labelled by its negative is a reliable misclick. */}
                        <TableCell className="text-center">
                          <div className="flex items-center justify-center gap-2">
                            <Switch
                              checked={!u.isHidden}
                              disabled={rowBusy}
                              onCheckedChange={(visible) =>
                                applyChange(
                                  u,
                                  { isHidden: !visible },
                                  visible
                                    ? `${u.username} is now visible on Account Management`
                                    : `${u.username} is hidden from Account Management`,
                                )
                              }
                              aria-label={`Show ${u.username} on Account Management`}
                            />
                            {u.isHidden ? (
                              <EyeOff size={14} className="text-gray-400" />
                            ) : (
                              <Eye size={14} className="text-green-600" />
                            )}
                          </div>
                        </TableCell>

                        <TableCell className="text-center">
                          <Switch
                            checked={co}
                            disabled={rowBusy}
                            onCheckedChange={(on) =>
                              applyChange(
                                u,
                                { features: { co: on } },
                                on
                                  ? `CO enabled for ${u.username}`
                                  : `CO disabled for ${u.username}`,
                              )
                            }
                            aria-label={`CO for ${u.username}`}
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <p className="text-xs text-muted-foreground">
          CO is reserved and currently has no effect anywhere in the app —
          toggling it only records the grant against the account.
        </p>
      </div>
    </HrLayout>
  );
}
