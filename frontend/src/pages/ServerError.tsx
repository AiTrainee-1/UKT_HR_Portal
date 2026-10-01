import { useMemo } from "react";
import { Home, RotateCw } from "lucide-react";
import SupportContactCard from "@/components/SupportContactCard";
import { StatusActions, StatusButton, StatusScreen } from "@/components/status/StatusScreen";

/** A lazy page that no longer exists after the app was updated: the fix is a reload, not a bug report. */
export function isStaleAppError(error?: Error | null): boolean {
  return /loading chunk|dynamically imported module|importing a module script failed|failed to fetch dynamically/i.test(
    error?.message ?? "",
  );
}

type Props = {
  error?: Error | null;
  /** Try the screen again without reloading (the error boundary clears itself). */
  onRetry?: () => void;
};

/** The screen for "something broke on our side": a page that crashed, or an app that was updated while it was open. */
export default function ServerError({ error, onRetry }: Props) {
  const stale = isStaleAppError(error);
  // Something short to read out to support, so they can find this error in the logs.
  const reference = useMemo(() => `ERR-${Date.now().toString(36).toUpperCase().slice(-6)}`, []);

  return (
    <StatusScreen
      tone={stale ? "info" : "warning"}
      code={stale ? undefined : "500"}
      icon={stale ? RotateCw : undefined}
      badge={stale ? "Update available" : "Server error"}
      title={stale ? "UKTextiles was just updated" : "Something broke on our side"}
      description={
        stale
          ? "A newer version of the application is available. Reload this page to pick it up. Nothing you saved has been lost."
          : "An unexpected error stopped this page from loading. It isn't anything you did. Try again, and if it keeps happening, tell Software Support the reference below."
      }
      details={[
        { label: "Reference", value: reference },
        { label: "Page", value: window.location.pathname },
        { label: "Time", value: new Date().toLocaleString("en-IN") },
        ...(error?.message ? [{ label: "Message", value: error.message.slice(0, 200), tone: "bad" as const }] : []),
      ]}
    >
      {!stale && <SupportContactCard situation="server" tone="dark" compact className="mb-5" />}
      <StatusActions>
        {stale || !onRetry ? (
          <StatusButton icon={RotateCw} onClick={() => window.location.reload()}>
            Reload page
          </StatusButton>
        ) : (
          <>
            <StatusButton icon={RotateCw} onClick={onRetry}>
              Try again
            </StatusButton>
            <StatusButton variant="ghost" onClick={() => window.location.reload()}>
              Reload page
            </StatusButton>
          </>
        )}
        <StatusButton variant="ghost" href="/" icon={Home}>
          Home
        </StatusButton>
      </StatusActions>
    </StatusScreen>
  );
}
