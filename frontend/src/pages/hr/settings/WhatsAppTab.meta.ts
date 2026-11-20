import type { SettingMeta } from "./kit/catalog";

const WHATSAPP = ["whatsapp", "wa", "meta", "cloud api", "message", "whatsapp control"];

/** Every setting on the WhatsApp tab, for the page's search (see kit/catalog.ts). */
export const WHATSAPP_SETTINGS: SettingMeta[] = [
  {
    id: "whatsapp-connection",
    tab: "whatsapp",
    section: "Meta WhatsApp Cloud API",
    title: "Connection and credentials",
    purpose:
      "The Meta access token, phone number ID, WhatsApp Business account ID, app secret and webhook verify token are kept only in the server's environment (the WHATSAPP_CLOUD_* variables in the .env file, or the hosting's variables), never in the database or on any page, so a database backup or a screenshot cannot leak them. Changing them needs a server restart.",
    keywords: [
      ...WHATSAPP,
      "token",
      "access token",
      "phone number id",
      "waba",
      "business account",
      "app secret",
      "credentials",
      "configured",
      "status",
      "env",
      "webhook",
      "verify token",
    ],
  },
  {
    id: "whatsapp-message-text",
    tab: "whatsapp",
    section: "WhatsApp messages and switches",
    title: "Message templates",
    purpose:
      "Every WhatsApp message goes out as a template Meta has approved: its wording, its variables and its attachment. Templates are made from the HRMS wording of each message type, checked against Meta's rules, submitted for review and kept in step with Meta.",
    keywords: [
      ...WHATSAPP,
      "template",
      "templates",
      "wording",
      "text",
      "approved",
      "rejected",
      "sync",
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
    title: "Message switches, limits and timings",
    purpose:
      "Switch the whole WhatsApp engine, a whole section (documents, attendance alerts, approvals, Department Heads, visitors, gate) or any single message type on or off, and set the sending limits, quiet hours and alert timings. Sign-in codes have a tab of their own (OTP).",
    keywords: [
      ...WHATSAPP,
      "otp",
      "sign in",
      "alerts",
      "approvals",
      "outpass",
      "gate",
      "switch",
      "engine",
      "limits",
      "quiet hours",
      "timing",
      "expiry",
    ],
  },
  {
    id: "whatsapp-cost",
    tab: "whatsapp",
    section: "WhatsApp usage and cost",
    title: "Usage, cost and monthly budget",
    purpose:
      "Messages per day and per type, the estimated cost so far and the projected month (with and without 18% GST), Meta's own figures, and a monthly budget the Overview warns against. The price per category is set on WhatsApp Control > Settings.",
    keywords: [
      ...WHATSAPP,
      "usage",
      "cost",
      "price",
      "rate",
      "budget",
      "gst",
      "credits",
      "spend",
      "billing",
      "monthly",
    ],
  },
];
