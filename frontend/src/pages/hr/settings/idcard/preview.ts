import type { IdCardData, IdCardSettingsItem } from "@/lib/api-client/custom-hooks";
import { isHexColour } from "../identity/colours";

export type TemplateForm = Omit<IdCardSettingsItem, "updatedAt">;

/** The template before HR has saved one (IdCardSettings defaults, backend/api/models/system.py). */
export const DEFAULT_TEMPLATE: TemplateForm = {
  primaryColor: "#006496",
  secondaryColor: "#4FB8F0",
  textColor: "#0f172a",
  fontFamily: "Hanken Grotesk",
  backgroundStyle: "gradient",
  logoPosition: "left",
  cornerStyle: "rounded",
  showQrOnBack: true,
  footerText: "",
};

/** The footer line is printed in a fixed-height card; past about three lines it pushes the QR code and gets cut off. */
export const FOOTER_MAX = 120;

/** Only these two typefaces are loaded by the portal (index.html); the others show only on PCs that have them. */
export const LOADED_FONTS = ["Hanken Grotesk", "Inter"];

/** The template to draw while something is still being typed: a colour that is not a full code yet is drawn as the
 *  default, so the example stays readable (the field itself says what is wrong, and Save waits for a valid code). */
export function drawableTemplate(form: TemplateForm): TemplateForm {
  return {
    ...form,
    primaryColor: isHexColour(form.primaryColor) ? form.primaryColor : DEFAULT_TEMPLATE.primaryColor,
    secondaryColor: isHexColour(form.secondaryColor) ? form.secondaryColor : DEFAULT_TEMPLATE.secondaryColor,
    textColor: isHexColour(form.textColor) ? form.textColor : DEFAULT_TEMPLATE.textColor,
  };
}

export type CardCompany = IdCardData["company"];

/** A made-up employee (the one the document previews use), on the card the ID Cards page would draw. */
export function sampleCard(template: TemplateForm, company: CardCompany, production: boolean): IdCardData {
  return {
    id: 0,
    code: production ? "SAMPLE-002" : "SAMPLE-001",
    name: production ? "Murugan K" : "Priya Sharma",
    designation: production ? "Tailor" : "HR Executive",
    department: production ? "Stitching" : "Human Resources",
    branchName: "Head Office",
    branchCode: "HO",
    unitCode: null,
    employmentType: production ? "production" : "staff",
    photoUrl: null,
    bloodGroup: "B+",
    dateOfBirth: "1994-05-12",
    emergencyContact: "+91 98765 43210",
    address: "12 MG Road, Coimbatore, Tamil Nadu - 641001",
    phone: null,
    email: null,
    joinDate: "2024-01-15",
    status: "active",
    company,
    template,
  };
}

export const SURFACES = [
  "ID Cards page",
  "Employee Mobile App",
  "Employee Web App",
  "Picture sent by email / WhatsApp",
] as const;
const SURFACE_PHRASES = [
  "the ID Cards page",
  "the Employee Mobile App",
  "the Employee Web App",
  "the picture sent by email or WhatsApp",
] as const;

/**
 * Which of the places that draw an ID card honour each option (read from their code: IdCardViews.tsx; the mobile app's
 * app/idcard/index.tsx; the Employee Web App's components/idcard/IdCardViews.tsx; backend idcard_render.py).
 */
export const HONOURED: Record<keyof TemplateForm, readonly [boolean, boolean, boolean, boolean]> = {
  primaryColor: [true, true, false, true],
  secondaryColor: [true, true, false, false],
  textColor: [true, false, false, false],
  fontFamily: [true, false, false, false],
  backgroundStyle: [true, false, false, false],
  logoPosition: [true, false, false, false],
  cornerStyle: [true, false, false, false],
  footerText: [true, false, false, false],
  showQrOnBack: [true, true, true, false],
};

/** "the ID Cards page and the Employee Mobile App" for an option, from the table above. */
export function honouredBy(option: keyof TemplateForm): string {
  const names = SURFACE_PHRASES.filter((_, i) => HONOURED[option][i]);
  if (names.length === 1) return `only ${names[0]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
