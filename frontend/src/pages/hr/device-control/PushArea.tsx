import { Fingerprint, LayoutGrid, Table2, UserMinus, UserPen, UserPlus } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { CircleLoader } from "@/components/ui/CircleLoader";
import type { DeviceControlOverview } from "@/lib/api-client/custom-hooks";
import AddUsersView from "./AddUsersView";
import DeleteUsersView from "./DeleteUsersView";
import EditUsersView from "./EditUsersView";
import { CloudNotice } from "./parts";
import PushTab from "./PushTab";
import { SubTabBar, useView, type SubTab } from "./SubTabs";
import UsersInDeviceView from "./UsersInDeviceView";
import { PUSH_VIEWS, type PushView } from "./logic";

const VIEWS: SubTab<PushView>[] = [
  { value: "overview", label: "Overview", icon: <LayoutGrid size={14} /> },
  { value: "add", label: "Add Users", icon: <UserPlus size={14} /> },
  { value: "edit", label: "Edit Users", icon: <UserPen size={14} /> },
  { value: "delete", label: "Delete Users", icon: <UserMinus size={14} /> },
  { value: "users", label: "Users in Device", icon: <Table2 size={14} /> },
];

/**
 * Data Push (owner 2026-11-17): five sub-tabs. Overview is the Data Push page as it was; Add / Edit / Delete Users and
 * Users in Device each do one job. All of them go through the same server calls, so a device is reached the way
 * Settings -> Devices -> Connect via says (straight from this server, or through its Site Connector), and every change
 * is kept in the history of user changes.
 */
export default function PushArea({
  overview,
  loading,
}: {
  overview: DeviceControlOverview | undefined;
  loading: boolean;
}) {
  const [view, setView] = useView(PUSH_VIEWS);
  const devices = overview?.devices ?? [];
  const enabled = devices.filter((d) => d.isActive);

  return (
    <div className="space-y-4" data-testid="push-area">
      <SubTabBar items={VIEWS} value={view} onChange={setView} testId="push-views" />
      {view === "overview" ? (
        <PushTab overview={overview} loading={loading} />
      ) : loading ? (
        <CircleLoader texts={["UK Textiles", "Device Control", "Loading"]} />
      ) : enabled.length === 0 ? (
        <Card className="rounded-2xl">
          <CardContent
            className="flex flex-col items-center gap-3 px-6 py-14 text-center"
            data-testid="push-no-devices"
          >
            <div className="rounded-2xl bg-blue-50 p-4 text-blue-600">
              <Fingerprint size={26} />
            </div>
            <p className="font-bold text-gray-900">No biometric device is switched on</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              Add each machine in Settings → Devices, then come back to manage the people on it.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <CloudNotice devices={devices} />
          {view === "add" && <AddUsersView devices={devices} />}
          {view === "edit" && <EditUsersView devices={devices} />}
          {view === "delete" && <DeleteUsersView devices={devices} />}
          {view === "users" && <UsersInDeviceView devices={devices} />}
        </>
      )}
    </div>
  );
}
