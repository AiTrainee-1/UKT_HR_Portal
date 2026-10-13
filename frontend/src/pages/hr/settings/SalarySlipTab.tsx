import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FileText, Image as ImageIcon, PenLine } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  getPayrollSettingsQueryKey,
  useDocumentSettings,
  usePayrollSettings,
  useUpdatePayrollSettings,
  type DocumentSettingsItem,
  type PayrollSettingsItem,
} from "@/lib/api-client/custom-hooks";
import { ManagedElsewhere, PreviewCard, PreviewLine, SettingBlock, SettingsSection } from "./kit/SettingBlock";
import { SALARY_SLIP_SETTINGS } from "./SalarySlipTab.meta";
import { BranchNote } from "./identity/BranchNote";
import {
  documentContactLine,
  footerNote,
  idCardCompany,
  letterheadName,
  slipHeader,
  verifyPageCompany,
  type CompanyValues,
} from "./identity/company-outputs";
import { DocumentSketch, type DocumentSketchProps, type SketchPart } from "./identity/DocumentSketch";
import { errorText } from "./identity/errors";
import { ImageUpload } from "./identity/ImageUpload";
import { metaOf } from "./identity/meta";
import { SaveFooter } from "./identity/SaveFooter";
import { useDraft } from "./identity/useDraft";
import { minWageCases, parseMinWage, pdfRupee } from "./salary-slip/preview";

type SlipForm = {
  slipCompanyName: string;
  slipCompanyAddress: string;
  /** As typed; an empty box is saved as 0, as before. */
  minWageRate: string;
  signatureImage: string | null;
  authorizedSignature: string | null;
};

const EMPTY: SlipForm = {
  slipCompanyName: "",
  slipCompanyAddress: "",
  minWageRate: "",
  signatureImage: null,
  authorizedSignature: null,
};

const fromSettings = (s: PayrollSettingsItem | undefined): SlipForm =>
  s
    ? {
        slipCompanyName: s.slipCompanyName ?? "",
        slipCompanyAddress: s.slipCompanyAddress ?? "",
        minWageRate: s.minWageRate ? String(s.minWageRate) : "",
        signatureImage: s.signatureImage || null,
        authorizedSignature: s.authorizedSignature || null,
      }
    : EMPTY;

const companyOf = (s: PayrollSettingsItem | undefined): CompanyValues => ({
  companyName: s?.companyName ?? "",
  companyAddress: s?.companyAddress ?? "",
  companyPhone: s?.companyPhone ?? "",
  companyEmail: s?.companyEmail ?? "",
  companyWebsite: s?.companyWebsite ?? "",
  companyGstin: s?.companyGstin ?? "",
  companyTagline: s?.companyTagline ?? "",
});

const text = (id: string) => metaOf(SALARY_SLIP_SETTINGS, id);

/** The parts of a document page the saved Company Documents look decides (the defaults of a new document row). */
function lookOf(look: DocumentSettingsItem | undefined) {
  return {
    primary: look?.primaryColor ?? "#0E4B3A",
    accent: look?.accentColor ?? "#C9A227",
    headingStyle: look?.headingStyle ?? ("serif" as const),
    showWatermark: look?.showWatermark ?? true,
    tagline: look?.footerTagline ?? "Weaving Quality. Building Trust.",
    logoOverride: look?.logoOverride || null,
  };
}

export default function SalarySlipTab({ readOnly = false }: { readOnly?: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: settings } = usePayrollSettings();
  const update = useUpdatePayrollSettings();
  // The saved looks of the salary slip and the offer letter (Company Documents), to draw the examples truthfully.
  const { data: slipLookData } = useDocumentSettings("salary_slip");
  const { data: letterLookData } = useDocumentSettings("offer_letter");

  const saved = useMemo(() => fromSettings(settings), [settings]);
  const { form, set, discard, dirty } = useDraft(saved);
  const disabled = readOnly || !settings;
  const branchLogin = settings?.companyWideRulesEditable === false;

  const company = companyOf(settings);
  const slipLook = lookOf(slipLookData);
  const letterLook = lookOf(letterLookData);
  const header = slipHeader(form, company.companyName);
  const verify = verifyPageCompany(form);
  const cardCompany = idCardCompany(company, form);
  const wage = parseMinWage(form.minWageRate);
  const cases = minWageCases(wage.problem ? 0 : wage.value);
  const companyLogo = settings?.companyLogo || null;
  const cardSignature = form.authorizedSignature
    ? "the authorised signature (letters)"
    : form.signatureImage
      ? "the employer signature, because the authorised one is empty"
      : 'no signature, only the "Authorised Signatory" line';

  const slipSketch = (extra: Partial<DocumentSketchProps>): DocumentSketchProps => ({
    doc: "salary_slip",
    label: "Salary slip drawn with these settings",
    primary: slipLook.primary,
    accent: slipLook.accent,
    headingStyle: slipLook.headingStyle,
    logo: slipLook.logoOverride || companyLogo,
    name: header.name,
    address: header.address,
    watermark: slipLook.showWatermark ? letterheadName(company.companyName) : null,
    tagline: slipLook.tagline,
    contactLine: documentContactLine(company),
    note: footerNote("salary_slip", company.companyName, "SAMPLE-PREVIEW"),
    signature: form.signatureImage,
    minWage: pdfRupee(wage.problem ? 0 : wage.value),
    ...extra,
  });

  const cutOut = (part: SketchPart, label: string) => (
    <DocumentSketch {...slipSketch({ crop: part, highlight: [part], width: 340, label })} />
  );

  const save = async () => {
    if (!settings || wage.problem) return;
    try {
      const result = await update.mutateAsync({
        slipCompanyName: form.slipCompanyName.trim(),
        slipCompanyAddress: form.slipCompanyAddress.trim(),
        minWageRate: wage.value,
        // null is meaningful: it removes a saved signature (it used to be dropped, so a removed signature came back).
        signatureImage: form.signatureImage,
        authorizedSignature: form.authorizedSignature,
      });
      queryClient.setQueryData(getPayrollSettingsQueryKey(), result);
      discard();
      toast({
        title: "Salary Slip settings saved",
        description: branchLogin
          ? "Saved as your branch's own copy. Salary slip PDFs and letters keep printing the company's values."
          : "Slips are drawn when they are opened, so every slip downloaded, e-mailed or sent on WhatsApp from now on shows this, older months included. Files already sent do not change.",
      });
    } catch (e) {
      toast({ title: "Failed to save Salary Slip settings", description: errorText(e), variant: "destructive" });
    }
  };

  return (
    <div className="space-y-4">
      {branchLogin && <BranchNote what="Salary slip details" />}

      <SettingsSection
        icon={FileText}
        title="Salary Slip Settings"
        purpose="What the top of every salary slip says, and the minimum wage printed on it. The slip's colours, heading font, footer slogan and watermark are on the Company Documents tab; its logo, footer contact line and watermark text come from the Company tab."
        usedBy={[
          { label: "Staff Payroll", to: "/hr/payroll" },
          { label: "Production Payroll", to: "/hr/production-payroll" },
          { label: "Employee apps" },
          { label: "Slip emails and WhatsApp" },
        ]}
      >
        <PreviewCard
          title="A salary slip with these settings"
          scenario="The sample slip the Company Documents preview uses (Priya Sharma, July 2026, net 19,675.00), drawn with what is typed below and the saved look of salary slips."
          testId="slip-overview"
        >
          <div className="grid gap-3 sm:grid-cols-[auto_minmax(0,1fr)]">
            <DocumentSketch {...slipSketch({ width: 230 })} />
            <ul className="min-w-0 space-y-1.5 text-[12px] leading-snug text-gray-600" data-testid="slip-sources">
              <li>
                <b className="text-gray-800">Name and address at the top, minimum wage, employer signature:</b> this
                tab.
              </li>
              <li>
                <b className="text-gray-800">Logo:</b> the Company tab (or a logo set for salary slips on the Company
                Documents tab).
              </li>
              <li>
                <b className="text-gray-800">Colours, heading font, footer slogan, watermark on or off:</b> Company
                Documents, Salary Slip.
              </li>
              <li>
                <b className="text-gray-800">Watermark text and the footer contact line:</b> the Company tab's name,
                address, phone, email and website.
              </li>
              <li>
                <b className="text-gray-800">The 2-slips-per-page print</b> uses only this tab's name and the two
                colours: no logo, address, signature, watermark or footer, and its signature line is blank.
              </li>
            </ul>
          </div>
        </PreviewCard>

        <SettingBlock
          {...text("slip-company-name")}
          labelFor="slip-company-name-input"
          affects={[
            {
              where: "Salary slip PDF",
              what: "the name at the top, in capitals: HR downloads, the employee apps, slip emails and WhatsApp",
              to: "/hr/payroll",
            },
            { where: "2-slips-per-page print", what: "the name at the top of each slip" },
            { where: "QR verification page", what: "the company named on the public page a scanned ID card opens" },
            {
              where: "ID cards and emails",
              what: "used for the company name only when the Company tab's name is blank",
              to: "/hr/settings?tab=company",
            },
          ]}
          defaultText="UK TEXTILES - H.O"
          note="Blank means the slip header falls back to the Company tab's name. The slip's footer and watermark always use the Company tab's name and contact details, so a slip can show two names: this one at the top and the Company tab's at the foot."
          preview={
            <PreviewCard title="Top of the slip">
              {cutOut("name", "Top of a salary slip")}
              <PreviewLine label="Slip header" result={header.name} />
              <PreviewLine label="QR verification page" result={verify.name || "(blank)"} />
            </PreviewCard>
          }
        >
          <Input
            id="slip-company-name-input"
            value={form.slipCompanyName}
            disabled={disabled}
            placeholder="UK TEXTILES - H.O"
            maxLength={120}
            onChange={(e) => set("slipCompanyName", e.target.value)}
            data-testid="input-slipCompanyName"
          />
        </SettingBlock>

        <SettingBlock
          {...text("slip-company-address")}
          labelFor="slip-company-address-input"
          affects={[
            { where: "Salary slip PDF", what: "the line under the name at the top", to: "/hr/payroll" },
            { where: "QR verification page", what: "the address under the company name" },
            {
              where: "ID cards",
              what: "the address on the card only when the Company tab's address is blank",
              to: "/hr/id-cards",
            },
          ]}
          defaultText="TIRUPUR"
          note="Blank prints no line at all (nothing is put in its place). The 2-slips-per-page print has no address line."
          preview={
            <PreviewCard title="Top of the slip">
              {cutOut("address", "Address line at the top of a salary slip")}
              <PreviewLine label="Line under the name" result={header.address || "(no line)"} />
              <PreviewLine label="ID cards show" result={cardCompany.address || "(no address)"} />
            </PreviewCard>
          }
        >
          <Input
            id="slip-company-address-input"
            value={form.slipCompanyAddress}
            disabled={disabled}
            placeholder="TIRUPUR"
            maxLength={200}
            onChange={(e) => set("slipCompanyAddress", e.target.value)}
            data-testid="input-slipCompanyAddress"
          />
        </SettingBlock>

        <SettingBlock
          {...text("min-wage-rate")}
          labelFor="min-wage-rate-input"
          affects={[
            {
              where: "Salary slip PDF",
              what: 'the "Minimum Rate of Wages" row of the personal details ("Min. Rate of Wages" on the 2-per-page print), 0.00 when not set',
              to: "/hr/payroll",
            },
            {
              where: "Minimum Wage Compliance report",
              what: "the figure each slip's wage is compared with; with 0 the report says it is not set",
              to: "/hr/reports",
            },
          ]}
          defaultText="0 (not set)"
          note="The figure has no unit and no zone or skill category. The compliance report asks whether to read it per paid day / shift or per month, so the same number can pass or fail. Decide which it is and keep to it."
          preview={
            <PreviewCard
              title="What the compliance report says"
              scenario="Two made-up slips checked against the figure typed above."
            >
              {cutOut("minWage", "Minimum Rate of Wages row on a salary slip")}
              {cases.length === 0 ? (
                <PreviewLine
                  label="Not set"
                  result="slips print 0.00 and the report says there is nothing to compare"
                  tone="info"
                  testId="min-wage-unset"
                />
              ) : (
                cases.map((c) => (
                  <PreviewLine
                    key={c.label}
                    label={`${c.label}, ${c.reading}: ${pdfRupee(c.wage)}`}
                    result={c.result === "OK" ? "OK" : `Below minimum, ${pdfRupee(c.shortfall)} short`}
                    tone={c.result === "OK" ? "good" : "bad"}
                    testId="min-wage-case"
                  />
                ))
              )}
            </PreviewCard>
          }
        >
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-gray-500">{"₹"}</span>
            <Input
              id="min-wage-rate-input"
              type="number"
              inputMode="decimal"
              min={0}
              step="0.01"
              value={form.minWageRate}
              disabled={disabled}
              placeholder="700"
              aria-invalid={wage.problem ? true : undefined}
              onChange={(e) => set("minWageRate", e.target.value)}
              data-testid="input-minWageRate"
            />
          </div>
          {wage.problem && (
            <p role="alert" className="text-xs font-medium text-red-600">
              {wage.problem}
            </p>
          )}
        </SettingBlock>
      </SettingsSection>

      <SettingsSection
        icon={PenLine}
        title="Signatures"
        purpose="Two separate signature images: one for salary slips, one for letters and ID cards. Removing one takes effect when you save."
        usedBy={[
          { label: "Salary slips", to: "/hr/payroll" },
          { label: "Letters", to: "/hr/recruitment/documents" },
          { label: "ID cards", to: "/hr/id-cards" },
        ]}
      >
        <SettingBlock
          {...text("slip-signature")}
          affects={[
            {
              where: "Salary slip PDF",
              what: 'above "Employer Signature": HR downloads, the employee apps, slip emails and WhatsApp',
              to: "/hr/payroll",
            },
            {
              where: "ID cards",
              what: "the signature on the back, only when the authorised signature below is empty",
              to: "/hr/id-cards",
            },
          ]}
          defaultText="No signature"
          note="The 2-slips-per-page print leaves a blank signature line instead. It is printed 2.6 x 1.2 cm without keeping its shape."
          preview={
            <PreviewCard title="Bottom of the slip">
              {cutOut("signature", "Employer signature on a salary slip")}
              <PreviewLine label="ID card back shows" result={cardSignature} />
            </PreviewCard>
          }
        >
          <ImageUpload
            id="slip-signature-file"
            value={form.signatureImage}
            onChange={(v) => set("signatureImage", v)}
            noun="signature"
            disabled={disabled}
          />
        </SettingBlock>

        <SettingBlock
          {...text("authorised-signature")}
          affects={[
            {
              where: "Offer letters and experience certificates",
              what: 'above "Authorized Signatory" ("Company Seal" under it on the certificate)',
              to: "/hr/recruitment/documents",
            },
            {
              where: "Resignation acceptance letters",
              what: 'above "Authorized Signatory"',
              to: "/hr/recruitment/resignations",
            },
            {
              where: "ID cards",
              what: "the signature on the back on the ID Cards page and in both employee apps",
              to: "/hr/id-cards",
            },
          ]}
          defaultText="No signature"
          note="Not used on salary slips. It is printed 3 x 1.4 cm without keeping its shape."
          preview={
            <PreviewCard title="Foot of a letter">
              <DocumentSketch
                doc="offer_letter"
                label="Signature on an offer letter"
                crop="signature"
                highlight={["signature"]}
                width={340}
                primary={letterLook.primary}
                accent={letterLook.accent}
                headingStyle={letterLook.headingStyle}
                logo={letterLook.logoOverride || companyLogo}
                name={letterheadName(company.companyName)}
                address={company.companyAddress}
                watermark={null}
                tagline={letterLook.tagline}
                contactLine={documentContactLine(company)}
                note={footerNote("offer_letter", company.companyName)}
                signature={form.authorizedSignature}
              />
              <PreviewLine label="ID card back shows" result={cardSignature} />
            </PreviewCard>
          }
        >
          <ImageUpload
            id="authorised-signature-file"
            value={form.authorizedSignature}
            onChange={(v) => set("authorizedSignature", v)}
            noun="authorised signature"
            disabled={disabled}
          />
        </SettingBlock>
      </SettingsSection>

      <SettingsSection
        icon={ImageIcon}
        title="Logo on the slip"
        purpose="The salary slip prints the company logo. It is kept in one place, the Company tab, so it cannot get out of step between tabs."
      >
        <div className="flex flex-wrap items-center gap-4">
          {companyLogo ? (
            <img
              src={companyLogo}
              alt="Saved company logo"
              className="h-16 rounded-lg border border-gray-200 bg-white object-contain p-2"
              data-testid="slip-logo-readonly"
            />
          ) : (
            <span className="rounded-lg border border-dashed border-gray-300 px-4 py-3 text-xs text-gray-500">
              No company logo saved
            </span>
          )}
          <div className="min-w-0 flex-1">
            <ManagedElsewhere
              title="Edit the logo on the Company tab"
              to="/hr/settings?tab=company"
              linkLabel="Company tab"
            >
              The same logo heads the sidebar, letters, ID cards and report headers. A different logo for salary slips
              only can be set as the Salary Slip document's logo on the Company Documents tab.
            </ManagedElsewhere>
          </div>
        </div>
      </SettingsSection>

      <SaveFooter
        dirty={dirty}
        saving={update.isPending}
        onSave={save}
        onDiscard={discard}
        saveLabel="Save Salary Slip Settings"
        disabled={disabled || !dirty || Boolean(wage.problem)}
        hint={
          !settings
            ? "Loading the saved details…"
            : wage.problem
              ? "Fix the minimum wage first."
              : dirty
                ? "You have changes that are not saved yet. Slips keep the saved details until you save."
                : undefined
        }
      />
    </div>
  );
}
