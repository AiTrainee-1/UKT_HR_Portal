import type { KeyboardEvent } from "react";
import { Redirect, useLocation, useSearch } from "wouter";
import { BellRing } from "lucide-react";
import HrLayout from "@/components/HrLayout";
import { RefreshButton } from "@/components/PageRefreshBar";
import { PillTabs } from "@/components/ui/pill-tabs";
import { useLevel, visibleItems } from "@/lib/tab-access";
import ConfigTab from "./phone-notify-control/ConfigTab";
import ControlsTab from "./phone-notify-control/ControlsTab";
import EmployeesTab from "./phone-notify-control/EmployeesTab";
import { VIEW_ONLY_TEXT } from "./phone-notify-control/logic";
import MessagesTab from "./phone-notify-control/MessagesTab";
import MessageTextTab from "./phone-notify-control/MessageTextTab";
import OverviewTab from "./phone-notify-control/OverviewTab";
import SendTab from "./phone-notify-control/SendTab";
import SettingsTab from "./phone-notify-control/SettingsTab";
import { LockContext } from "./phone-notify-control/ui";
import {
  PN_TABS,
  cleanPnPath,
  pnTabModule,
  pnTabPath,
  readPnPath,
  resolvePnPath,
  type PnTabKey,
} from "./phone-notify-control/routes";

/**
 * Left / Right / Home / End move between the tabs of the row and open the one they land on, the way a tab list is used with a
 * keyboard (the pills are all buttons too, so Tab and Enter work as well).
 */
function onTabKeys(event: KeyboardEvent<HTMLDivElement>) {
  if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
  const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const at = tabs.indexOf(document.activeElement as HTMLButtonElement);
  if (at < 0) return;
  event.preventDefault();
  const to =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (at + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  tabs[to].focus();
  tabs[to].click();
}

/**
 * Phone Notify Control: every phone (push) notification the HRMS sends, a module of its own (it shares no wording, switch
 * or timing with the other control pages). A notification is always saved in the employee's app; unless a switch stops it, it is also pushed to the employee's
 * registered phones through the Expo push service and Google's Firebase. Until 2026-11-17 this was the Mobile Messages tab of
 * Mobile App Login.
 *
 * One page with its tabs in the path (/hr/phone-notify-control/overview, /messages, /employees, /controls, /send,
 * /configuration, /message-text, /settings): the bare page, or an unknown tab, is replaced by the first tab the role may open, and only the tab on screen
 * is rendered, so a tab that is not open asks the server for nothing. Each tab has its own permission key
 * (`phone_notify_control.send`, following the page while unset) and its own route in the tree: the route guard (App.tsx)
 * turns away the address of a hidden one, HrLayout locks a View-only one, this page offers only the ones the role may open,
 * and its own switches and buttons are disabled on a View-only tab too (some of their words are not ones the lock knows).
 * The Overview's category switches and its Push again also need the Controls / Messages tab's right (`canEdit`), the key the
 * server checks for them.
 */
export default function PhoneNotifyControl() {
  const [location, navigate] = useLocation();
  const search = useSearch();
  const level = useLevel();

  const visibleTabs = visibleItems(PN_TABS, (t) => pnTabModule(t.value), level);
  const visible = visibleTabs.map((t) => t.value);
  const canOpen = (tab: PnTabKey) => visible.includes(tab);
  const canEdit = (tab: PnTabKey) => level(pnTabModule(tab)) === "edit";

  const here = cleanPnPath(location);
  const target = resolvePnPath(here, visible);
  if (visibleTabs.length > 0 && target !== here) {
    return <Redirect to={`${target}${search ? `?${search}` : ""}`} replace />;
  }

  const current = readPnPath(here) ?? visible[0] ?? PN_TABS[0].value;
  const lockedWhy = level(pnTabModule(current)) !== "edit" ? VIEW_ONLY_TEXT : null;

  return (
    <HrLayout>
      <div className="space-y-5" data-testid="phone-notify-page">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            {/* the title sits on the layout's own light background: a fixed dark ink, as on the other control pages */}
            <h2 className="flex items-center gap-2 text-2xl font-black text-gray-900">
              <BellRing size={22} className="text-violet-600" /> Phone Notify Control
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Manage and monitor every phone notification the HRMS sends, and switch each kind on or off
            </p>
          </div>
          <RefreshButton />
        </div>

        {visibleTabs.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="pn-nothing-open">
            Nothing on this page is open to your role.
          </p>
        ) : (
          <>
            {/* the tabs only open a tab: never locked by View only (one of them is called "Send a message") */}
            <div onKeyDown={onTabKeys} className="max-w-full overflow-x-auto" data-testid="pn-subtabs" data-view-safe>
              <PillTabs
                items={visibleTabs.map((t) => ({ value: t.value, label: t.label }))}
                value={current}
                onChange={(next) => navigate(pnTabPath(next as PnTabKey))}
                baseColor="#4f46e5"
                size="sm"
              />
            </div>

            <LockContext.Provider value={lockedWhy}>
              <div
                role="tabpanel"
                aria-label={PN_TABS.find((t) => t.value === current)?.label}
                data-testid={`pn-panel-${current}`}
              >
                {current === "overview" && <OverviewTab canOpen={canOpen} canEdit={canEdit} />}
                {current === "messages" && <MessagesTab />}
                {current === "employees" && <EmployeesTab />}
                {current === "controls" && <ControlsTab />}
                {current === "send" && <SendTab />}
                {current === "configuration" && <ConfigTab />}
                {current === "templates" && <MessageTextTab />}
                {current === "settings" && <SettingsTab />}
              </div>
            </LockContext.Provider>
          </>
        )}
      </div>
    </HrLayout>
  );
}
