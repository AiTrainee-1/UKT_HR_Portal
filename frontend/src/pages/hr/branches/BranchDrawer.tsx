import { ExternalLink, Hash, Layers, MapPin, Pencil, Phone, Trash2, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { Branch } from "@/lib/api-client/custom-hooks";
import type { BranchSummaryRow } from "./api";
import { CodeChip, GeofenceChip, HeadOfficeChip, peopleLabel } from "./BranchViews";
import { hasGeofence, mapLink, nextUnitCode } from "./logic";

type Props = {
  branch: Branch | null;
  /** The branch's figures; undefined while they load or when they could not be read. */
  row?: BranchSummaryRow;
  figuresLoading: boolean;
  onClose: () => void;
  onEdit: (b: Branch) => void;
  onDelete: (b: Branch) => void;
};

function Figure({ label, value, tone }: { label: string; value: number | string; tone: string }) {
  return (
    <div className={`rounded-xl p-3 ${tone}`}>
      <p className="text-[11px] font-medium opacity-70">{label}</p>
      <p className="text-xl font-black leading-tight">{value}</p>
    </div>
  );
}

function Line({ icon: Icon, children }: { icon: typeof Phone; children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-sm text-gray-700">
      <Icon size={14} className="mt-0.5 shrink-0 text-gray-400" />
      <span className="min-w-0 break-words">{children}</span>
    </p>
  );
}

/** Everything about one branch: contact, headcount, its departments, the unit-code counter and the geofence. */
export default function BranchDrawer({ branch, row, figuresLoading, onClose, onEdit, onDelete }: Props) {
  const next = branch ? nextUnitCode(branch, row) : null;
  return (
    <Sheet open={branch !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md" data-testid="branch-drawer">
        {branch && (
          <>
            <SheetHeader className="text-left">
              <SheetTitle className="flex flex-wrap items-center gap-2 pr-6">
                {branch.name}
                <CodeChip code={branch.code} />
              </SheetTitle>
              <SheetDescription className="sr-only">Details of the {branch.name} branch</SheetDescription>
              <div className="flex flex-wrap items-center gap-1.5">
                {branch.isHeadOffice && <HeadOfficeChip />}
                <GeofenceChip branch={branch} />
              </div>
            </SheetHeader>

            <div className="mt-5 space-y-5">
              <section className="space-y-2">
                <h3 className="text-xs font-bold uppercase tracking-wide text-gray-500">Contact</h3>
                {branch.location && <Line icon={MapPin}>{branch.location}</Line>}
                {branch.address && <Line icon={MapPin}>{branch.address}</Line>}
                {branch.phone && <Line icon={Phone}>{branch.phone}</Line>}
                {branch.managerName && <Line icon={User}>{branch.managerName}</Line>}
                {!branch.location && !branch.address && !branch.phone && !branch.managerName && (
                  <p className="text-sm text-muted-foreground">
                    No address or phone recorded. Edit the branch to add them.
                  </p>
                )}
              </section>

              <section className="space-y-2">
                <h3 className="text-xs font-bold uppercase tracking-wide text-gray-500">People</h3>
                {row ? (
                  <>
                    <div className="grid grid-cols-3 gap-2" data-testid="drawer-figures">
                      <Figure label="Staff" value={row.staffActive} tone="bg-blue-50 text-blue-800" />
                      <Figure label="Production" value={row.productionActive} tone="bg-orange-50 text-orange-800" />
                      <Figure label="Inactive" value={row.inactive} tone="bg-slate-100 text-slate-700" />
                    </div>
                    <p className="text-xs text-muted-foreground">{peopleLabel(row)} work in this branch now.</p>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {figuresLoading ? "Loading the headcount..." : "The headcount could not be loaded."}
                  </p>
                )}
              </section>

              {row && (
                <section className="space-y-2">
                  <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-gray-500">
                    <Layers size={12} /> Departments ({row.departments.length})
                  </h3>
                  {row.departments.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No department belongs to this branch yet.</p>
                  ) : (
                    <ul className="divide-y rounded-xl border" data-testid="drawer-departments">
                      {row.departments.map((d) => (
                        <li key={d.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                          <span className="min-w-0 truncate">{d.name}</span>
                          <span className="shrink-0 text-xs text-gray-500">{d.activeCount} active</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              )}

              <section className="space-y-2">
                <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-gray-500">
                  <Hash size={12} /> Unit codes
                </h3>
                {branch.code ? (
                  <p className="text-sm text-gray-700" data-testid="drawer-unit-code">
                    {row ? (
                      <>
                        {row.nextEmployeeSeq} issued so far. The next employee gets <b className="font-mono">{next}</b>.
                      </>
                    ) : (
                      <>
                        New employees get codes like <b className="font-mono">{branch.code}-n</b>.
                      </>
                    )}
                  </p>
                ) : (
                  <p className="text-sm text-amber-700">
                    This branch has no code, so employees added to it get no unit code. Edit the branch to give it one.
                  </p>
                )}
              </section>

              <section className="space-y-2">
                <h3 className="text-xs font-bold uppercase tracking-wide text-gray-500">Attendance location</h3>
                {hasGeofence(branch) ? (
                  <div className="space-y-1.5 text-sm text-gray-700" data-testid="drawer-geofence">
                    <p className="font-mono text-xs">
                      {Number(branch.geofenceLat).toFixed(6)}, {Number(branch.geofenceLng).toFixed(6)}
                    </p>
                    <p>Employees within {branch.geofenceRadiusM ?? 200} metres can mark attendance from the app.</p>
                    <a
                      href={mapLink(Number(branch.geofenceLat), Number(branch.geofenceLng))}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 hover:underline"
                    >
                      Open on map <ExternalLink size={11} />
                    </a>
                  </div>
                ) : (
                  <p className="text-sm text-amber-700">
                    No location set: employees of this branch cannot mark attendance from the app until one is picked on
                    the map.
                  </p>
                )}
              </section>

              <div className="flex gap-2 border-t pt-4">
                <Button onClick={() => onEdit(branch)} className="flex-1 gap-1.5" data-testid="drawer-edit">
                  <Pencil size={14} /> Edit
                </Button>
                <Button
                  variant="outline"
                  onClick={() => onDelete(branch)}
                  className="gap-1.5 text-red-600 hover:bg-red-50 hover:text-red-700"
                  data-testid="drawer-delete"
                >
                  <Trash2 size={14} /> Delete
                </Button>
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
