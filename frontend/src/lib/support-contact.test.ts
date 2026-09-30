import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONTACT_FORM_KEYS,
  FALLBACK_TEXT,
  SUPPORT_CONTACT_STORAGE_KEY,
  contactFor,
  dialHref,
  isSupportContact,
  mailHref,
  previewFromForm,
  readCachedSupportContact,
  validateContactField,
  validateContactForm,
  whatsappHref,
  writeCachedSupportContact,
  type ContactForm,
  type SupportContact,
  type SupportContactBlock,
} from "./support-contact";

const block = (over: Partial<SupportContactBlock> = {}): SupportContactBlock => ({
  label: "HR Department",
  phone: "0421 430 0800",
  phoneDial: "04214300800",
  whatsapp: "98765 43210",
  whatsappNumber: "919876543210",
  email: "hr@uktex.net",
  hours: "Mon–Sat, 9–6",
  hasContact: true,
  usesHrFallback: false,
  ...over,
});

const EMPTY_BLOCK = block({
  label: "Software Support",
  phone: "",
  phoneDial: "",
  whatsapp: "",
  whatsappNumber: "",
  email: "",
  hours: "",
  hasContact: false,
});

const contact = (over: Partial<SupportContact> = {}): SupportContact => ({
  hr: block(),
  support: EMPTY_BLOCK,
  note: "First floor.",
  companyName: "UKTextiles",
  configured: true,
  updatedAt: null,
  ...over,
});

const form = (over: Partial<ContactForm> = {}): ContactForm => ({
  hrContactName: "",
  hrContactPhone: "",
  hrContactWhatsapp: "",
  hrContactEmail: "",
  hrContactHours: "",
  supportContactName: "",
  supportContactPhone: "",
  supportContactWhatsapp: "",
  supportContactEmail: "",
  supportContactHours: "",
  contactNote: "",
  ...over,
});

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("isSupportContact", () => {
  it("accepts the API contract", () => {
    expect(isSupportContact(contact())).toBe(true);
  });

  it("rejects anything that isn't shaped like it, so a stray answer is never shown", () => {
    for (const bad of [null, undefined, "x", 5, [], {}, { hr: {}, support: {} }, { ...contact(), hr: null }]) {
      expect(isSupportContact(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(isSupportContact({ ...contact(), configured: "yes" })).toBe(false);
    expect(isSupportContact({ ...contact(), hr: { ...block(), phone: 9876543210 } })).toBe(false);
    expect(isSupportContact({ ...contact(), note: undefined })).toBe(false);
  });
});

describe("links", () => {
  it("builds tel, wa.me and mailto links from the normalised fields, not the display text", () => {
    const b = block();
    expect(dialHref(b)).toBe("tel:04214300800");
    expect(whatsappHref(b)).toBe("https://wa.me/919876543210");
    expect(mailHref(b)).toBe("mailto:hr@uktex.net");
  });

  it("gives no link for an empty field, so no dead button is drawn", () => {
    expect([dialHref(EMPTY_BLOCK), whatsappHref(EMPTY_BLOCK), mailHref(EMPTY_BLOCK)]).toEqual(["", "", ""]);
  });
});

describe("contactFor", () => {
  it("shows HR for sign-in and app problems, and Software Support when the server is down", () => {
    const data = contact({
      support: block({ label: "Software Support", phone: "98765 11111", phoneDial: "9876511111" }),
    });
    expect(contactFor(data, "hr")?.label).toBe("HR Department");
    expect(contactFor(data, "server")?.label).toBe("Software Support");
  });

  it("is null when nothing is known or nothing is set, so the caller shows the plain sentence", () => {
    expect(contactFor(null, "hr")).toBeNull();
    expect(contactFor(undefined, "server")).toBeNull();
    expect(contactFor(contact({ hr: EMPTY_BLOCK }), "hr")).toBeNull();
    expect(FALLBACK_TEXT.hr).toBe("Please contact your HR department.");
    expect(FALLBACK_TEXT.server).toBe("Please contact your software support team.");
  });
});

describe("the copy kept on the device", () => {
  it("round-trips through localStorage", () => {
    writeCachedSupportContact(contact());
    expect(readCachedSupportContact()).toEqual(contact());
  });

  it("returns null for nothing stored, corrupt JSON or a stored value of the wrong shape", () => {
    expect(readCachedSupportContact()).toBeNull();
    window.localStorage.setItem(SUPPORT_CONTACT_STORAGE_KEY, "{not json");
    expect(readCachedSupportContact()).toBeNull();
    window.localStorage.setItem(SUPPORT_CONTACT_STORAGE_KEY, JSON.stringify({ hr: 1 }));
    expect(readCachedSupportContact()).toBeNull();
  });

  it("survives storage throwing (private windows, full disk)", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    expect(() => writeCachedSupportContact(contact())).not.toThrow();
    expect(readCachedSupportContact()).toBeNull();
  });
});

describe("Settings form validation", () => {
  it("accepts blanks and the usual ways of writing a number or an address", () => {
    expect(validateContactForm(form())).toBeNull();
    for (const phone of ["0421 430 0800", "+91 98765 43210", "(0421) 430-0800", "98765.43210", "9876543210"]) {
      expect(validateContactField("hrContactPhone", phone), phone).toBeNull();
    }
    expect(validateContactField("hrContactEmail", "hr@uktex.net")).toBeNull();
  });

  it("rejects what would make a dead tel: link or a broken mailto:", () => {
    for (const phone of [
      "12345",
      "abcdefghij",
      "98765 43210 / 98765 43211",
      "9876543210, 9876543211",
      "98+76543210",
      "+91 98765 43210 12345",
    ]) {
      expect(validateContactField("hrContactPhone", phone), phone).toMatch(/must be one phone number/);
    }
    for (const email of ["hr", "hr@", "hr@uktex", "hr @uktex.net", "a@b.co, c@d.co"]) {
      expect(validateContactField("hrContactEmail", email), email).toMatch(/valid email/);
    }
  });

  it("enforces the same length limits as the server, counting a tidy value", () => {
    expect(validateContactField("hrContactName", "x".repeat(80))).toBeNull();
    expect(validateContactField("hrContactName", "x".repeat(81))).toMatch(/at most 80/);
    expect(validateContactField("contactNote", "x".repeat(501))).toMatch(/at most 500/);
    expect(validateContactField("hrContactHours", `  ${"a ".repeat(10)}  `)).toBeNull();
  });

  it("reports the first problem in the whole form", () => {
    const problem = validateContactForm(form({ hrContactEmail: "nope", supportContactPhone: "1" }));
    expect(problem).toMatch(/HR email/);
    expect(CONTACT_FORM_KEYS).toHaveLength(11);
  });
});

describe("previewFromForm", () => {
  it("shows what employees would see for the typed values, before saving", () => {
    const p = previewFromForm(
      form({ hrContactPhone: "+91 98765 43210", hrContactEmail: " hr@uktex.net ", contactNote: " Hi " }),
    );
    expect(p.hr).toMatchObject({
      label: "HR Department",
      phoneDial: "+919876543210",
      email: "hr@uktex.net",
      hasContact: true,
    });
    expect(p.note).toBe("Hi");
    expect(p.configured).toBe(true);
  });

  it("falls back to HR for the server situation when support is blank, as the server does", () => {
    const p = previewFromForm(form({ hrContactPhone: "0421 430 0800" }));
    expect(p.support.usesHrFallback).toBe(true);
    expect(p.support.phone).toBe("0421 430 0800");
    expect(contactFor(p, "server")?.phone).toBe("0421 430 0800");
  });

  it("uses a support contact of its own once one is entered, and the default names when a name is blank", () => {
    const p = previewFromForm(
      form({ hrContactPhone: "0421 430 0800", supportContactEmail: "it@uktex.net", supportContactName: "  " }),
    );
    expect(p.support).toMatchObject({ label: "Software Support", email: "it@uktex.net", usesHrFallback: false });
  });

  it("is not configured while nothing is entered", () => {
    const p = previewFromForm(form({ hrContactName: "Only a name" }));
    expect(p.configured).toBe(false);
    expect(contactFor(p, "hr")).toBeNull();
  });
});
