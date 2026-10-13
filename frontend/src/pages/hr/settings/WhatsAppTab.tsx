import { MessageCircle, SlidersHorizontal } from "lucide-react";
import { permissionLevel, useAuth } from "@/contexts/AuthContext";
import { ManagedElsewhere, PreviewCard, PreviewLine, SettingBlock, SettingsSection } from "./kit/SettingBlock";
import { WhatsAppBubble } from "./whatsapp/WhatsAppBubble";

const CONTROL = "/hr/whatsapp-control";

/**
 * Settings -> WhatsApp. Everything WhatsApp is set on WhatsApp Control (the wording and on/off of all 24 messages, the
 * feature switches and timings, the connection status) or in the server's environment (the WAClient credentials). This
 * tab used to repeat the status and 7 of the messages; it now explains where each part lives and links there.
 */
export default function WhatsAppTab() {
  const { user } = useAuth();
  const blocked = Boolean(user) && permissionLevel(user, "whatsapp_control") === "hidden";
  const noAccess = blocked ? " Your role cannot open WhatsApp Control; ask an administrator." : "";

  return (
    <div className="space-y-4">
      <SettingsSection
        icon={MessageCircle}
        title="WAClient WhatsApp API"
        purpose="WhatsApp messages go out through a WhatsApp number linked to a WAClient instance. Nothing about the connection is set on this page."
        usedBy={[{ label: "WhatsApp Control", to: CONTROL }]}
        testId="whatsapp-connection-section"
      >
        <SettingBlock
          id="whatsapp-connection"
          title="Connection and credentials"
          purpose="The WAClient instance ID and access token are kept only in the server's environment (the .env file, or the hosting's variables), never in the database or on any page, so a database backup or a screenshot cannot leak them. Changing them needs a server restart."
          affects={[
            {
              where: "Every WhatsApp message",
              what: "is sent only while the connection is configured: salary slips, ID cards and letters, sign-in codes, attendance alerts, approval notices, visitor and gate pass messages",
            },
            {
              where: "Employee sign-in",
              what: "without the connection employees get no one-time code and sign in with their password instead",
            },
            {
              where: "WhatsApp Control > Configuration",
              to: CONTROL,
              what: "shows whether it is configured, which instance, the webhook address for delivery receipts and a setup checklist",
            },
          ]}
          note='On a development machine (debug mode on, or started with runserver) sending is switched off on purpose unless WHATSAPP_ALLOW_SENDING=true is set. WhatsApp Control then says "Not configured" even though the credentials are there.'
        >
          <ManagedElsewhere
            title="Connection status and setup checklist"
            to={CONTROL}
            linkLabel="Open WhatsApp Control"
            testId="whatsapp-managed-connection"
          >
            {`Open the Configuration tab.${noAccess}`}
          </ManagedElsewhere>
        </SettingBlock>
      </SettingsSection>

      <SettingsSection
        icon={SlidersHorizontal}
        title="WhatsApp messages and switches"
        purpose="What each WhatsApp message says and whether it is sent. All of it is set on WhatsApp Control, next to the record of every message sent."
        usedBy={[{ label: "WhatsApp Control", to: CONTROL }]}
        testId="whatsapp-messages-section"
      >
        <SettingBlock
          id="whatsapp-message-text"
          title="Message text and per-message on/off"
          purpose="The wording of each of the 24 WhatsApp messages (salary slip, ID card, the letters, other documents, the visitor notice, sign-in codes, attendance alerts, approval and gate pass messages) and a switch that stops one kind of message."
          affects={[
            {
              where: "WhatsApp Control > Message Text",
              to: CONTROL,
              what: "edit the wording with a live preview and the variables each message can use; a blank text sends the built-in wording",
            },
            {
              where: "Every message of that kind",
              what: "uses the saved wording from the next send. A document switched off is refused and listed as failed; a visitor notice switched off is skipped without a record",
            },
          ]}
          note="This tab used to have its own copy of 7 of these messages. It changed the same wording and the same switch as WhatsApp Control, so they now live only there."
          preview={
            <PreviewCard
              title="Example"
              scenario="Asha Kumar's August 2026 salary slip, sent on WhatsApp from Payroll. It goes out only when all four are true:"
              testId="whatsapp-send-chain"
            >
              <PreviewLine label="1. The connection is configured" result="server environment" tone="info" />
              <PreviewLine label="2. This server is allowed to send" result="not a development setup" tone="info" />
              <PreviewLine
                label='3. "Document notifications" is on'
                result="WhatsApp Control > Feature Controls"
                tone="info"
              />
              <PreviewLine
                label='4. The "Salary Slip" message is on'
                result="WhatsApp Control > Message Text"
                tone="info"
              />
              <WhatsAppBubble
                text={
                  "*Salary Slip*\n\nHello Asha Kumar,\n\nYour salary slip for *August 2026* is attached.\n\nRegards,\nUK Textiles HRMS"
                }
                attachment="Salary slip (PDF)"
              />
              <p className="text-[11px] text-gray-500">
                The built-in wording, with the slip attached. WhatsApp Control &gt; Messages then shows it as sent,
                delivered and read.
              </p>
            </PreviewCard>
          }
        >
          <ManagedElsewhere
            title="Wording and on/off of every message"
            to={CONTROL}
            linkLabel="Open WhatsApp Control"
            testId="whatsapp-managed-messages"
          >
            {`Open the Message Text tab.${noAccess}`}
          </ManagedElsewhere>
        </SettingBlock>

        <SettingBlock
          id="whatsapp-feature-controls"
          title="Feature switches and timings"
          purpose="Turn whole WhatsApp features on or off (sign-in codes, document messages, attendance alerts, approval notices for each workflow, visitor and gate pass messages) and set their timings, such as how long a sign-in code lasts and when attendance alerts go out."
          affects={[
            {
              where: "WhatsApp Control > Feature Controls",
              to: CONTROL,
              what: "a feature switched off stops every message of that feature, whatever each message's own switch says",
            },
            {
              where: "Employee sign-in",
              what: "the sign-in code switches decide whether employees can sign in, reset a password or activate an account with a WhatsApp code",
            },
          ]}
        >
          <ManagedElsewhere
            title="Feature switches and timings"
            to={CONTROL}
            linkLabel="Open WhatsApp Control"
            testId="whatsapp-managed-features"
          >
            {`Open the Feature Controls tab.${noAccess}`}
          </ManagedElsewhere>
        </SettingBlock>
      </SettingsSection>
    </div>
  );
}
