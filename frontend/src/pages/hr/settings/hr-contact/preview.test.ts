import { describe, expect, it } from "vitest";
import { dialFor, looksForeign, whatsappNumberFor } from "./preview";

// Expected values are what the server returns in GET /api/support-contact (support_contact_views._dial and
// whatsapp_service.normalize_phone); e2e/hr-contact.spec.ts checks the first two against the real endpoint.
describe("support contact links", () => {
  it("dials the digits as typed, keeping a leading +", () => {
    expect(dialFor("0421 430 0800")).toBe("04214300800");
    expect(dialFor("+91 98765-43210")).toBe("+919876543210");
    expect(dialFor("")).toBe("");
  });

  it("builds the WhatsApp number the way the server does", () => {
    expect(whatsappNumberFor("98765 43210")).toBe("919876543210");
    expect(whatsappNumberFor("098765 43210")).toBe("919876543210");
    expect(whatsappNumberFor("+91 98765 43210")).toBe("919876543210");
    expect(whatsappNumberFor("0091 98765 43210")).toBe("919876543210");
    // Starts with 91 but is only a 10-digit Indian mobile: still gets the country code.
    expect(whatsappNumberFor("9123456789")).toBe("919123456789");
    expect(whatsappNumberFor("0421 430 0800")).toBe("914214300800");
    expect(whatsappNumberFor("")).toBe("");
  });

  it("puts 91 in front of a foreign number too, which the page warns about", () => {
    expect(whatsappNumberFor("+44 20 7946 0958")).toBe("91442079460958");
    expect(looksForeign("+44 20 7946 0958")).toBe(true);
    expect(looksForeign("0044 20 7946 0958")).toBe(true);
    expect(looksForeign("+91 98765 43210")).toBe(false);
    expect(looksForeign("98765 43210")).toBe(false);
  });
});
