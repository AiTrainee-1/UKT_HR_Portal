import type { KeyboardEvent } from "react";
import { Redirect, useLocation, useSearch } from "wouter";
import { MessageSquareText } from "lucide-react";
import HrLayout from "@/components/HrLayout";
import { RefreshButton } from "@/components/PageRefreshBar";
import { SubtabBar } from "@/components/ui/subtab-nav";
import { useAuth } from "@/contexts/AuthContext";
import { useLevel, visibleItems } from "@/lib/tab-access";
import { BRANCH_ONLY_TEXT, VIEW_ONLY_TEXT } from "./sms-control/logic";
import MessagesTab from "./sms-control/MessagesTab";
import OverviewTab from "./sms-control/OverviewTab";
import SettingsTab from "./sms-control/SettingsTab";
import SetupTab from "./sms-control/SetupTab";
import TestTab from "./sms-control/TestTab";
import { LockContext } from "./sms-control/ui";
import {
  SETTINGS_SECTIONS,
  SMS_BASE,
  SMS_TABS,
  cleanSmsPath,
  readSmsPath,
  resolveSmsPath,
  smsSectionModule,
  smsTabModule,
} from "./sms-control/routes";

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
 * SMS Control: login, password-reset and activation codes can go by SMS (through 2Factor) instead of WhatsApp, and this is where HR sees
 * and controls that. One page with its tabs in the path (/hr/sms-control/overview, /settings/limits, /messages, /test, /setup):
 * a path that stops early, or names an unknown tab, is replaced by the first one the role may open, and only the tab on screen
 * is rendered, so a tab that is not open asks the server for nothing. Each tab and Settings section has its own permission key
 * (`sms_control.test`, `sms_control.settings.limits`; each follows the one above it while unset): the route guard (App.tsx)
 * turns away the address of a hidden one, this page offers only the ones the role may open, and one the role has as View Only
 * can be looked at but not changed.
 */
export default function SmsControl() {
  const { user } = useAuth();
  const [location] = useLocation();
  const search = useSearch();
  const level = useLevel();

  const visibleTabs = visibleItems(SMS_TABS, (t) => smsTabModule(t.value), level);
  const visibleSections = visibleItems(SETTINGS_SECTIONS, (s) => smsSectionModule(s.value), level);
  const visible = { tabs: visibleTabs.map((t) => t.value), sections: visibleSections.map((s) => s.value) };

  const here = cleanSmsPath(location);
  const target = resolveSmsPath(here, visible);
  if (visibleTabs.length > 0 && target !== here) {
    return <Redirect to={`${target}${search ? `?${search}` : ""}`} replace />;
  }

  const { tab, nested } = readSmsPath(here);
  const current = tab ?? visible.tabs[0] ?? SMS_TABS[0].value;
  // The most specific key on screen decides: the Settings section, else the tab (each follows the one above it while unset).
  const panelKey = current === "settings" && nested ? smsSectionModule(nested) : smsTabModule(current);
  // a View Only role looks but does not change; a branch login looks too (the settings and the test are company-wide)
  const lockedWhy = level(panelKey) !== "edit" ? VIEW_ONLY_TEXT : user?.branchId ? BRANCH_ONLY_TEXT : null;
  const readOnly = lockedWhy !== null;

  return (
    <HrLayout>
      <div className="space-y-5" data-testid="sms-control-page">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            {/* the title sits on the layout's own light background, not on a themed surface: a fixed dark ink, as on the
                WhatsApp and Gmail Control pages */}
            <h2 className="flex items-center gap-2 text-2xl font-black text-gray-900">
              <MessageSquareText size={22} className="text-sky-600" /> SMS Control
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Send login, password-reset and activation codes by SMS through 2Factor, and see that it is working
            </p>
          </div>
          <RefreshButton />
        </div>

        {visibleTabs.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="sms-nothing-open">
            Nothing on this page is open to your role.
          </p>
        ) : (
          <>
            <div onKeyDown={onTabKeys}>
              <SubtabBar
                base={SMS_BASE}
                items={visibleTabs.map((t) => ({ value: t.value, label: t.label }))}
                value={current}
                testId="sms-subtabs"
                landing={(next) => (next === "settings" ? visible.sections[0] : undefined)}
              />
            </div>

            <LockContext.Provider value={lockedWhy}>
              <div
                role="tabpanel"
                aria-label={SMS_TABS.find((t) => t.value === current)?.label}
                data-testid={`sms-panel-${current}`}
              >
                {current === "overview" && <OverviewTab />}
                {current === "settings" && nested && (
                  <SettingsTab section={nested} readOnly={readOnly} sections={visible.sections} />
                )}
                {current === "settings" && !nested && (
                  <p className="text-sm text-muted-foreground" data-testid="sms-settings-nothing-open">
                    Nothing in Settings is open to your role.
                  </p>
                )}
                {current === "messages" && <MessagesTab />}
                {current === "test" && <TestTab readOnly={readOnly} />}
                {current === "setup" && <SetupTab />}
              </div>
            </LockContext.Provider>
          </>
        )}
      </div>
    </HrLayout>
  );
}
