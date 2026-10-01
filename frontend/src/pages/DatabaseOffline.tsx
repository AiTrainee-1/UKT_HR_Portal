import { useState } from "react";
import { Database, RefreshCw } from "lucide-react";
import SupportContactCard from "@/components/SupportContactCard";
import { ConnectionPath, StatusActions, StatusButton, StatusScreen } from "@/components/status/StatusScreen";

export default function DatabaseOffline() {
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);

  const retryConnection = async () => {
    setChecking(true);
    setChecked(false);
    await new Promise((r) => setTimeout(r, 2000));
    setChecking(false);
    setChecked(true);
    window.location.reload();
  };

  return (
    <StatusScreen
      tone="danger"
      icon={Database}
      badge="Database unavailable"
      title="Database Server Offline"
      description="The database server is currently unavailable, so no data can be loaded. Please contact the system administration team, then refresh once the database server is available."
      above={<ConnectionPath states={{ device: "ok", network: "ok", server: "ok", database: "bad" }} />}
      details={[
        { label: "Application", value: "UKTextiles HR & ERP" },
        { label: "Database", value: "PostgreSQL (On-Premise)" },
        { label: "Status", value: "Unreachable", tone: "bad" },
        { label: "Checked at", value: new Date().toLocaleTimeString("en-IN") },
      ]}
    >
      {/* Who to contact: the Software Support details HR set in Settings -> HR Contact */}
      <SupportContactCard situation="server" tone="dark" className="mb-3" />
      <StatusActions>
        <StatusButton onClick={retryConnection} disabled={checking} icon={RefreshCw}>
          {checking ? "Checking connection…" : "Retry connection"}
        </StatusButton>
      </StatusActions>
      {checked && <p className="ss-text">Database still unreachable. Please contact IT support.</p>}
    </StatusScreen>
  );
}
