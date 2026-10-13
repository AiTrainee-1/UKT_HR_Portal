import type { SettingMeta } from "./kit/catalog";

const tab = "hr_contact";
const HR = "HR Department";
const SUPPORT = "Software / IT Support";
const NOTE = "Note for employees";

/** Every setting on the HR Contact tab, for the page's search (see kit/catalog.ts). */
export const HR_CONTACT_SETTINGS: SettingMeta[] = [
  {
    id: "hr-name",
    tab,
    section: HR,
    title: "Name shown to employees",
    purpose: "Who employees are calling: the heading of the HR contact card on help and server-down screens.",
    keywords: ["hr", "name", "label", "help desk", "contact"],
  },
  {
    id: "hr-phone",
    tab,
    section: HR,
    title: "Phone number",
    purpose: "The number an employee can tap to call HR when they cannot sign in or an app misbehaves.",
    keywords: ["hr", "phone", "call", "number", "sign in", "help"],
  },
  {
    id: "hr-whatsapp",
    tab,
    section: HR,
    title: "WhatsApp number",
    purpose: "A button that opens a WhatsApp chat with HR.",
    keywords: ["hr", "whatsapp", "chat", "number"],
  },
  {
    id: "hr-email",
    tab,
    section: HR,
    title: "Email",
    purpose: "The address employees can write to for help.",
    keywords: ["hr", "email", "mail", "help"],
  },
  {
    id: "hr-hours",
    tab,
    section: HR,
    title: "Available hours",
    purpose: "When HR can be reached, shown as a line under the buttons.",
    keywords: ["hr", "hours", "timing", "available"],
  },
  {
    id: "support-name",
    tab,
    section: SUPPORT,
    title: "Name shown to employees",
    purpose: "The heading of the contact card employees see when the server or the database is not working.",
    keywords: ["support", "it", "software", "server down", "name"],
  },
  {
    id: "support-phone",
    tab,
    section: SUPPORT,
    title: "Phone number",
    purpose: "The number to call when the system itself is down.",
    keywords: ["support", "it", "phone", "call", "server down"],
  },
  {
    id: "support-whatsapp",
    tab,
    section: SUPPORT,
    title: "WhatsApp number",
    purpose: "A button that opens a WhatsApp chat with IT / software support.",
    keywords: ["support", "it", "whatsapp", "chat"],
  },
  {
    id: "support-email",
    tab,
    section: SUPPORT,
    title: "Email",
    purpose: "The address of IT / software support.",
    keywords: ["support", "it", "email", "mail"],
  },
  {
    id: "support-hours",
    tab,
    section: SUPPORT,
    title: "Available hours",
    purpose: "When IT support can be reached, shown under the buttons of the server-down card.",
    keywords: ["support", "it", "hours", "timing"],
  },
  {
    id: "contact-note",
    tab,
    section: NOTE,
    title: "Shown under the contacts (optional)",
    purpose:
      "One shared line of extra guidance printed under the HR and support cards on help and server-down screens.",
    keywords: ["note", "message", "guidance", "office", "help"],
  },
];
