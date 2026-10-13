import type { SettingMeta } from "./kit/catalog";

const WHATSAPP = ["whatsapp", "wa", "waclient", "message", "whatsapp control"];

/** Every setting on the WhatsApp tab, for the page's search (see kit/catalog.ts). */
export const WHATSAPP_SETTINGS: SettingMeta[] = [
  {
    id: "whatsapp-connection",
    tab: "whatsapp",
    section: "WAClient WhatsApp API",
    title: "Connection and credentials",
    purpose:
      "The WAClient instance ID and access token are kept only in the server's environment (the .env file, or the hosting's variables), never in the database or on any page, so a database backup or a screenshot cannot leak them. Changing them needs a server restart.",
    keywords: [...WHATSAPP, "instance", "token", "credentials", "configured", "status", "env", "webhook"],
  },
  {
    id: "whatsapp-message-text",
    tab: "whatsapp",
    section: "WhatsApp messages and switches",
    title: "Message text and per-message on/off",
    purpose:
      "The wording of each of the 24 WhatsApp messages (salary slip, ID card, the letters, other documents, the visitor notice, sign-in codes, attendance alerts, approval and gate pass messages) and a switch that stops one kind of message.",
    keywords: [
      ...WHATSAPP,
      "wording",
      "text",
      "template",
      "caption",
      "salary slip",
      "id card",
      "offer letter",
      "experience letter",
      "resignation letter",
      "visitor",
    ],
  },
  {
    id: "whatsapp-feature-controls",
    tab: "whatsapp",
    section: "WhatsApp messages and switches",
    title: "Feature switches and timings",
    purpose:
      "Turn whole WhatsApp features on or off (sign-in codes, document messages, attendance alerts, approval notices for each workflow, visitor and gate pass messages) and set their timings, such as how long a sign-in code lasts and when attendance alerts go out.",
    keywords: [...WHATSAPP, "otp", "sign in", "alerts", "approvals", "outpass", "gate", "switch", "timing", "expiry"],
  },
];
