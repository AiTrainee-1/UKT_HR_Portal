import type { KeyboardEvent } from "react";
import { Redirect, useLocation, useSearch } from "wouter";
import { MessageSquareText } from "lucide-react";
import HrLayout from "@/components/HrLayout";
import { RefreshButton } from "@/components/PageRefreshBar";
import { SubtabBar } from "@/components/ui/subtab-nav";
import { permissionLevel, useAuth } from "@/contexts/AuthContext";
import { BRANCH_ONLY_TEXT, VIEW_ONLY_TEXT } from "./sms-control/logic";
import MessagesTab from "./sms-control/MessagesTab";
import OverviewTab from "./sms-control/OverviewTab";
import SettingsTab from "./sms-control/SettingsTab";
import SetupTab from "./sms-control/SetupTab";
import TestTab from "./sms-control/TestTab";
import { LockContext } from "./sms-control/ui";
import {
  SMS_BASE,
  SMS_CONTROL_MODULE,
  SMS_TABS,
  cleanSmsPath,
  nestedOf,
  readSmsPath,
  resolveSmsPath,
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
 * a path that stops early, or names an unknown tab, is replaced by the first one, and only the tab on screen is rendered, so a
 * tab that is not open asks the server for nothing. The whole /hr/sms-control prefix is gated by the one `sms_control`
 * permission module (App.tsx); a role that has it as View Only can look at everything and change nothing.
 */
export default function SmsControl() {
  const { user } = useAuth();
  const [location] = useLocation();
  const search = useSearch();

  const here = cleanSmsPath(location);
  const target = resolveSmsPath(here);
  if (target !== here) return <Redirect to={`${target}${search ? `?${search}` : ""}`} replace />;

  const { tab, nested } = readSmsPath(here);
  // a View Only role looks but does not change; a branch login looks too (the settings and the test are company-wide)
  const lockedWhy =
    permissionLevel(user, SMS_CONTROL_MODULE) !== "edit" ? VIEW_ONLY_TEXT : user?.branchId ? BRANCH_ONLY_TEXT : null;
  const readOnly = lockedWhy !== null;
  const current = tab ?? SMS_TABS[0].value;

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

        <div onKeyDown={onTabKeys}>
          <SubtabBar
            base={SMS_BASE}
            items={SMS_TABS.map((t) => ({ value: t.value, label: t.label }))}
            value={current}
            testId="sms-subtabs"
            landing={(next) => nestedOf(next as typeof current)[0]?.value}
          />
        </div>

        <LockContext.Provider value={lockedWhy}>
          <div
            role="tabpanel"
            aria-label={SMS_TABS.find((t) => t.value === current)?.label}
            data-testid={`sms-panel-${current}`}
          >
            {current === "overview" && <OverviewTab />}
            {current === "settings" && nested && <SettingsTab section={nested} readOnly={readOnly} />}
            {current === "messages" && <MessagesTab />}
            {current === "test" && <TestTab readOnly={readOnly} />}
            {current === "setup" && <SetupTab />}
          </div>
        </LockContext.Provider>
      </div>
    </HrLayout>
  );
}
