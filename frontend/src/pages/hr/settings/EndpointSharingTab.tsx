import { useCallback, useMemo, useRef, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { Button } from "@/components/ui/button";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/contexts/AuthContext";
import { ApiError, getApiOrigin } from "@/lib/api-client/custom-fetch";
import { DEFAULT_LIMITS, useSharedCatalog } from "@/lib/api-client/custom-hooks";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ENDPOINT_SHARING_SUBTAB_OF } from "./EndpointSharingTab.meta";
import { saveErrorText, useSubTabFromAddress } from "./payroll/form";
import { ActivityLog } from "./endpoint-sharing/ActivityLog";
import {
  parseSharingAddress,
  sharingAddress,
  type Section,
  type SharingAddress,
  type Subtab,
} from "./endpoint-sharing/address";
import { EndpointEditor, type EditorNav } from "./endpoint-sharing/EndpointEditor";
import { EndpointsList } from "./endpoint-sharing/EndpointsList";
import { IntegrationGuide } from "./endpoint-sharing/IntegrationGuide";
import { Notice } from "./endpoint-sharing/ui";

const SUBTAB_ITEMS: { value: Subtab; label: string }[] = [
  { value: "endpoints", label: "Endpoints" },
  { value: "guide", label: "Integration guide" },
  { value: "activity", label: "Activity" },
];

/** Where the API lives, as a developer writes it: the configured API origin, or this page's own. */
function apiOrigin(): string {
  const configured = getApiOrigin();
  if (configured) return configured;
  return typeof window === "undefined" ? "" : window.location.origin;
}

/**
 * Settings -> Endpoint Sharing (super admin only). The owner publishes SELECTED HR data to other applications through
 * read-only endpoints, picks exactly which fields are shared, lists the websites that may call each one, makes API keys and
 * reads the integration guide. Three subtabs (Endpoints, Integration guide, Activity) in the page address (`sub=`); an open
 * endpoint has four nested sections (Basics, Data, Access, Guide), one at a time (`section=`).
 *
 * The tab is not a role permission: the Settings page does not list it for anybody else and the server refuses every
 * management call from anybody else. This component checks again, so it never draws for another login.
 */
export default function EndpointSharingTab({ readOnly = false }: { readOnly?: boolean }) {
  const { user } = useAuth();
  if (!(user?.role === "hr" && user.isSuperAdmin === true)) {
    return (
      <Notice tone="danger" testId="sharing-forbidden" title="Only the super admin can manage Endpoint Sharing">
        Your login is not the super admin, so nothing here is shown.
      </Notice>
    );
  }
  return <SharingTab readOnly={readOnly} />;
}

function SharingTab({ readOnly }: { readOnly: boolean }) {
  const search = useSearch();
  const [, navigate] = useLocation();
  const address = useMemo(() => parseSharingAddress(search), [search]);
  const addressRef = useRef(address);
  addressRef.current = address;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  const catalog = useSharedCatalog();
  const limits = catalog.data?.limits ?? DEFAULT_LIMITS;

  // unsaved work in the open editor: moving elsewhere asks first
  const dirtyRef = useRef(false);
  const setDirty = useCallback((dirty: boolean) => {
    dirtyRef.current = dirty;
  }, []);
  const [pending, setPending] = useState<(() => void) | null>(null);
  const attempt = useCallback((go: () => void) => {
    if (dirtyRef.current) setPending(() => go);
    else go();
  }, []);

  const goTo = useCallback((next: Partial<SharingAddress>, replace = false) => {
    navigateRef.current(sharingAddress({ ...addressRef.current, ...next }), { replace });
  }, []);

  // a link such as ?tab=endpoint_sharing#guide-cors (or the page's search) opens the subtab holding that card
  const openSub = useCallback(
    (sub: Subtab) => {
      if (addressRef.current.sub !== sub) attempt(() => goTo({ sub, endpoint: null, section: "basics" }));
    },
    [attempt, goTo],
  );
  useSubTabFromAddress(ENDPOINT_SHARING_SUBTAB_OF, openSub);

  const nav: EditorNav = {
    openSection: (section: Section) => goTo({ section }),
    back: () => attempt(() => goTo({ endpoint: null, section: "basics" })),
    openCreated: (id) => goTo({ endpoint: id, section: "access" }, true),
    afterDelete: () => goTo({ endpoint: null, section: "basics" }),
    setDirty,
  };

  const editing = address.sub === "endpoints" && address.endpoint !== null ? address.endpoint : null;
  const origin = apiOrigin();

  const changeSub = (value: string) => {
    const sub = value as Subtab;
    if (sub === address.sub) return;
    attempt(() =>
      goTo({
        sub,
        endpoint: sub === "activity" && typeof address.endpoint === "number" ? address.endpoint : null,
        section: "basics",
      }),
    );
  };

  const editor = () => {
    if (editing === null) return null;
    if (catalog.isLoading) {
      return (
        <div className="space-y-3" data-testid="catalog-loading">
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
      );
    }
    if (catalog.isError || !catalog.data) {
      const forbidden = catalog.error instanceof ApiError && catalog.error.status === 403;
      return (
        <div
          className="flex flex-wrap items-center gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"
          data-testid="catalog-error"
        >
          {forbidden
            ? (saveErrorText(catalog.error) ?? "Only the super admin can manage Endpoint Sharing.")
            : "The list of datasets could not be loaded, so an endpoint cannot be edited."}
          {!forbidden && (
            <Button size="sm" variant="outline" onClick={() => void catalog.refetch()}>
              Try again
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => goTo({ endpoint: null, section: "basics" })}>
            Back to all endpoints
          </Button>
        </div>
      );
    }
    return (
      <EndpointEditor
        target={editing}
        section={address.section}
        catalog={catalog.data}
        readOnly={readOnly}
        origin={origin}
        nav={nav}
      />
    );
  };

  return (
    <div className="space-y-4" data-testid="endpoint-sharing-tab" data-sub={address.sub}>
      <div className="max-w-full overflow-x-auto" data-testid="sharing-subtabs">
        <PillTabs items={SUBTAB_ITEMS} value={address.sub} onChange={changeSub} baseColor="#4f46e5" size="sm" />
      </div>

      <div
        className="space-y-4"
        role="tabpanel"
        aria-label={SUBTAB_ITEMS.find((s) => s.value === address.sub)?.label}
        data-testid={`sharing-panel-${address.sub}`}
      >
        {address.sub === "endpoints" &&
          (editing !== null ? (
            editor()
          ) : (
            <EndpointsList
              readOnly={readOnly}
              max={limits.maxEndpoints}
              onNew={() => goTo({ endpoint: "new", section: "basics" })}
              onOpen={(id) => goTo({ endpoint: id, section: "basics" })}
            />
          ))}
        {address.sub === "guide" && <IntegrationGuide origin={origin} />}
        {address.sub === "activity" && (
          <ActivityLog
            endpointId={typeof address.endpoint === "number" ? address.endpoint : null}
            onEndpoint={(id) => goTo({ endpoint: id }, true)}
          />
        )}
      </div>

      <AlertDialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <AlertDialogContent data-testid="confirm-leave">
          <AlertDialogHeader>
            <AlertDialogTitle>Leave without saving?</AlertDialogTitle>
            <AlertDialogDescription>
              You changed this endpoint and have not saved it. If you leave now, those changes are lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              data-testid="confirm-leave-yes"
              onClick={() => {
                const go = pending;
                setPending(null);
                dirtyRef.current = false;
                go?.();
              }}
            >
              Leave and lose my changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
