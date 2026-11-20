import { IndianRupee, MessageCircle, SlidersHorizontal } from "lucide-react";
import { permissionLevel, useAuth } from "@/contexts/AuthContext";
import { ManagedElsewhere, PreviewCard, PreviewLine, SettingBlock, SettingsSection } from "./kit/SettingBlock";
import { WhatsAppBubble } from "./whatsapp/WhatsAppBubble";

const CONTROL = "/hr/whatsapp-control";
const TAB = {
  config: `${CONTROL}?tab=config`,
  templates: `${CONTROL}?tab=templates`,
  controls: `${CONTROL}?tab=controls`,
  usage: `${CONTROL}?tab=usage`,
  otp: `${CONTROL}?tab=otp`,
};

/**
 * Settings -> WhatsApp. Everything WhatsApp is set on WhatsApp Control (since 2026-11-20 on the official Meta WhatsApp
 * Cloud API: the set-up check, the Meta templates, a switch for every message, the OTP codes, usage, cost and budget) or
 * in the server's environment (the WHATSAPP_CLOUD_* keys). This tab explains where each part lives and links there.
 */
export default function WhatsAppTab() {
  const { user } = useAuth();
  const blocked = Boolean(user) && permissionLevel(user, "whatsapp_control") === "hidden";
  const noAccess = blocked ? " Your role cannot open WhatsApp Control; ask an administrator." : "";

  return (
    <div className="space-y-4">
      <SettingsSection
        icon={MessageCircle}
        title="Meta WhatsApp Cloud API"
        purpose="WhatsApp messages go out through the official Meta WhatsApp Cloud API, from the company's WhatsApp Business number. Nothing about the connection is set on this page."
        usedBy={[{ label: "WhatsApp Control", to: CONTROL }]}
        testId="whatsapp-connection-section"
      >
        <SettingBlock
          id="whatsapp-connection"
          title="Connection and credentials"
          purpose="The Meta access token, phone number ID, WhatsApp Business account ID, app secret and webhook verify token are kept only in the server's environment (the WHATSAPP_CLOUD_* variables in the .env file, or the hosting's variables), never in the database or on any page, so a database backup or a screenshot cannot leak them. Changing them needs a server restart."
          affects={[
            {
              where: "Every WhatsApp message",
              what: "is sent only while the keys are set, and only as a template Meta approved: salary slips, ID cards and letters, sign-in codes, attendance alerts, approval notices, visitor and gate pass messages",
            },
            {
              where: "Employee sign-in",
              what: "WhatsApp codes need the approved code template; SMS codes (SMS Control) work on their own, and password sign-in is always there when neither can send",
            },
            {
              where: "WhatsApp Control > Settings",
              to: TAB.config,
              what: "lists each WHATSAPP_CLOUD_* variable as set or missing (never its value), the number's quality and messaging limit at Meta, and the webhook address to paste into Meta",
            },
          ]}
          note="On a development machine (debug mode on, or started with runserver) sending is switched off on purpose unless WHATSAPP_ALLOW_SENDING=true is set, and even then only the employees in WHATSAPP_ONLY_TO_EMPLOYEES are messaged."
        >
          <ManagedElsewhere
            title="Set-up check, webhook, prices and budget"
            to={TAB.config}
            linkLabel="Open WhatsApp Control"
            testId="whatsapp-managed-connection"
          >
            {`Open the Settings tab.${noAccess}`}
          </ManagedElsewhere>
        </SettingBlock>
      </SettingsSection>

      <SettingsSection
        icon={SlidersHorizontal}
        title="WhatsApp messages and switches"
        purpose="What each WhatsApp message says (its Meta template) and whether it is sent. All of it is set on WhatsApp Control, next to the record of every message sent."
        usedBy={[{ label: "WhatsApp Control", to: CONTROL }]}
        testId="whatsapp-messages-section"
      >
        <SettingBlock
          id="whatsapp-message-text"
          title="Message templates"
          purpose="Every WhatsApp message goes out as a template Meta has approved: its wording, its variables and its attachment. Templates are made from the HRMS wording of each message type, checked against Meta's rules, submitted for review and kept in step with Meta."
          affects={[
            {
              where: "WhatsApp Control > Templates",
              to: TAB.templates,
              what: "create a template from a message type with a live phone preview, create all missing ones at once, sync with Meta, see why Meta rejected one, delete one",
            },
            {
              where: "Every message of that kind",
              what: "is skipped (shown as Skipped on the Messages tab) while its template is missing, in review, rejected or paused",
            },
          ]}
          note="Until 2026-11-20 HR edited the text of each message on a Message Text tab. With Meta the approved template is the text, so that tab is gone."
          preview={
            <PreviewCard
              title="Example"
              scenario="Asha Kumar's August 2026 salary slip, sent on WhatsApp from Payroll. It goes out only when all five are true:"
              testId="whatsapp-send-chain"
            >
              <PreviewLine label="1. The Meta keys are set" result="server environment" tone="info" />
              <PreviewLine label="2. This server is allowed to send" result="not a development setup" tone="info" />
              <PreviewLine
                label='3. "Document notifications" is on'
                result="WhatsApp Control > Message Controls"
                tone="info"
              />
              <PreviewLine
                label='4. The "Salary Slip" message is on'
                result="WhatsApp Control > Message Controls"
                tone="info"
              />
              <PreviewLine
                label="5. Meta approved hrms_salary_slip"
                result="WhatsApp Control > Templates"
                tone="info"
              />
              <WhatsAppBubble
                text={"Dear Asha Kumar,\nYour salary slip for August 2026 is attached.\n\n- UK Textiles HR"}
                attachment="Salary slip (PDF)"
              />
              <p className="text-[11px] text-gray-500">
                The template with the slip attached. WhatsApp Control &gt; Messages then shows it as sent, delivered and
                read, and Usage &amp; Cost counts what it cost.
              </p>
            </PreviewCard>
          }
        >
          <ManagedElsewhere
            title="Templates of every message"
            to={TAB.templates}
            linkLabel="Open WhatsApp Control"
            testId="whatsapp-managed-messages"
          >
            {`Open the Templates tab.${noAccess}`}
          </ManagedElsewhere>
        </SettingBlock>

        <SettingBlock
          id="whatsapp-feature-controls"
          title="Message switches, limits and timings"
          purpose="Switch the whole WhatsApp engine, a whole section (documents, attendance alerts, approvals, Department Heads, visitors, gate) or any single message type on or off, and set the sending limits, quiet hours and alert timings. Sign-in codes have a tab of their own (OTP)."
          affects={[
            {
              where: "WhatsApp Control > Message Controls",
              to: TAB.controls,
              what: "a section switched off stops every message in it, whatever each message's own switch says; each message shows its template and this month's count",
            },
            {
              where: "Employee sign-in",
              to: TAB.otp,
              what: "WhatsApp Control > OTP turns WhatsApp codes on or off for sign-in, password reset and activation, independently of SMS codes",
            },
          ]}
        >
          <ManagedElsewhere
            title="Switches, limits and timings"
            to={TAB.controls}
            linkLabel="Open WhatsApp Control"
            testId="whatsapp-managed-features"
          >
            {`Open the Message Controls tab.${noAccess}`}
          </ManagedElsewhere>
        </SettingBlock>
      </SettingsSection>

      <SettingsSection
        icon={IndianRupee}
        title="WhatsApp usage and cost"
        purpose="What WhatsApp costs: Meta charges each delivered message by its pricing category."
        usedBy={[{ label: "WhatsApp Control", to: CONTROL }]}
        testId="whatsapp-cost-section"
      >
        <SettingBlock
          id="whatsapp-cost"
          title="Usage, cost and monthly budget"
          purpose="Messages per day and per type, the estimated cost so far and the projected month (with and without 18% GST), Meta's own figures, and a monthly budget the Overview warns against. The price per category is set on WhatsApp Control > Settings."
          affects={[
            {
              where: "WhatsApp Control > Usage & Cost",
              to: TAB.usage,
              what: "any month: the cost so far and projected, by category and by message type",
            },
            {
              where: "WhatsApp Control > Overview",
              to: CONTROL,
              what: "warns at 80% of the budget and as soon as the projection passes it (messages are never stopped by the budget)",
            },
          ]}
        >
          <ManagedElsewhere
            title="Usage and cost"
            to={TAB.usage}
            linkLabel="Open WhatsApp Control"
            testId="whatsapp-managed-cost"
          >
            {`Open the Usage & Cost tab.${noAccess}`}
          </ManagedElsewhere>
        </SettingBlock>
      </SettingsSection>
    </div>
  );
}
