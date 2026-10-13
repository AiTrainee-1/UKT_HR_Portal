import { useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, CreditCard, Minus, Palette, ScanLine, Type } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  getIdCardSettingsQueryKey,
  useIdCardSettings,
  usePayrollSettings,
  useUpdateIdCardSettings,
  type IdCardSettingsItem,
} from "@/lib/api-client/custom-hooks";
import {
  ProductionCardBack,
  ProductionCardFront,
  StaffCardBack,
  StaffCardFront,
  useQrCodes,
} from "@/components/idcard/IdCardViews";
import { cn } from "@/lib/utils";
import { PreviewCard, PreviewLine, SettingBlock, SettingsSection } from "./kit/SettingBlock";
import { ToggleField } from "./kit/Field";
import { ID_CARD_SETTINGS } from "./IdCardTab.meta";
import { ColourField } from "./identity/ColourField";
import { contrastRatio, contrastText, isHexColour, READABLE_RATIO } from "./identity/colours";
import { idCardCompany } from "./identity/company-outputs";
import { errorText } from "./identity/errors";
import { metaOf } from "./identity/meta";
import { SaveFooter } from "./identity/SaveFooter";
import { useDraft } from "./identity/useDraft";
import {
  DEFAULT_TEMPLATE,
  FOOTER_MAX,
  HONOURED,
  LOADED_FONTS,
  SURFACES,
  drawableTemplate,
  honouredBy,
  sampleCard,
  type TemplateForm,
} from "./idcard/preview";

const fromData = (d: IdCardSettingsItem | undefined): TemplateForm =>
  d
    ? {
        primaryColor: d.primaryColor,
        secondaryColor: d.secondaryColor,
        textColor: d.textColor,
        fontFamily: d.fontFamily,
        backgroundStyle: d.backgroundStyle,
        logoPosition: d.logoPosition,
        cornerStyle: d.cornerStyle,
        showQrOnBack: d.showQrOnBack,
        footerText: d.footerText ?? "",
      }
    : DEFAULT_TEMPLATE;

const text = (id: string) => metaOf(ID_CARD_SETTINGS, id);

const OPTION_ROWS: { key: keyof TemplateForm; label: string }[] = [
  { key: "primaryColor", label: "Primary Color" },
  { key: "secondaryColor", label: "Secondary Color" },
  { key: "textColor", label: "Text Color" },
  { key: "fontFamily", label: "Font Family" },
  { key: "backgroundStyle", label: "Background Style" },
  { key: "logoPosition", label: "Logo Position" },
  { key: "cornerStyle", label: "Corner Style" },
  { key: "footerText", label: "Footer Text" },
  { key: "showQrOnBack", label: "QR code on back" },
];

function Select({
  id,
  value,
  onChange,
  options,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
  disabled: boolean;
}) {
  return (
    <select
      id={id}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="h-9 w-full rounded-md border bg-background px-3 text-sm disabled:cursor-not-allowed disabled:opacity-60"
    >
      {options.map(([v, label]) => (
        <option key={v} value={v}>
          {label}
        </option>
      ))}
    </select>
  );
}

const usedByLine = (option: keyof TemplateForm) => (
  <PreviewLine label="Honoured by" result={honouredBy(option)} tone="info" />
);

export default function IdCardTab({ readOnly = false }: { readOnly?: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data } = useIdCardSettings();
  const { data: settings } = usePayrollSettings();
  const update = useUpdateIdCardSettings();
  const [production, setProduction] = useState(false);

  const saved = useMemo(() => fromData(data), [data]);
  const { form, set, discard, dirty } = useDraft(saved);
  const disabled = readOnly || !data;

  const company = useMemo(() => {
    const c = idCardCompany(
      { companyName: settings?.companyName ?? "", companyAddress: settings?.companyAddress ?? "" },
      { slipCompanyName: settings?.slipCompanyName ?? "", slipCompanyAddress: settings?.slipCompanyAddress ?? "" },
    );
    return {
      ...c,
      logo: settings?.companyLogo || null,
      signature: settings?.authorizedSignature || settings?.signatureImage || null,
    };
  }, [settings]);
  const template = useMemo(() => drawableTemplate(form), [form]);
  const card = useMemo(() => sampleCard(template, company, production), [template, company, production]);
  const qrs = useQrCodes([card]);

  const badColour = (["primaryColor", "secondaryColor", "textColor"] as const).some((k) => !isHexColour(form[k]));
  const footerTooLong = form.footerText.trim().length > FOOTER_MAX;
  const problem = badColour ? "Fix the colour codes first." : footerTooLong ? "Shorten the footer text first." : null;

  const save = async () => {
    if (problem) return;
    try {
      const result = await update.mutateAsync({ ...form, footerText: form.footerText.trim() });
      queryClient.setQueryData(getIdCardSettingsQueryKey(), result);
      discard();
      toast({
        title: "ID card template saved",
        description:
          "Cards are drawn fresh each time they are shown, so every card on the ID Cards page now looks like this, older ones included. The employee apps and the e-mailed picture use only some of these options. Cards already printed do not change.",
      });
    } catch (e) {
      toast({ title: "Failed to save ID card settings", description: errorText(e), variant: "destructive" });
    }
  };

  const colourBlock = (key: "primaryColor" | "secondaryColor" | "textColor", metaId: string, extra: ReactNode) => (
    <SettingBlock
      {...text(metaId)}
      labelFor={`idcard-${key}`}
      affects={
        key === "primaryColor"
          ? [
              {
                where: "ID Cards page",
                what: 'the top band (gradient start or solid fill), the "Employee Identity Card" strip text, the designation pill, the code strip, the edge strips and the icons on the back',
                to: "/hr/id-cards",
              },
              { where: "Employee Mobile App", what: "the top gradient, designation pill, code strip and footer strip" },
              {
                where: "Picture sent by email / WhatsApp",
                what: "the top band, the photo border and the bottom strip",
              },
            ]
          : key === "secondaryColor"
            ? [
                {
                  where: "ID Cards page",
                  what: "the end of the top band's gradient, the photo frame and its glow, the end of the code strip and the edge strips",
                  to: "/hr/id-cards",
                },
                { where: "Employee Mobile App", what: "the photo border and the ends of the gradients" },
              ]
            : [
                {
                  where: "ID Cards page",
                  what: "the employee's name and the Department, Branch and Joined Date values on the front (the back uses fixed greys)",
                  to: "/hr/id-cards",
                },
              ]
      }
      defaultText={DEFAULT_TEMPLATE[key]}
      preview={
        <PreviewCard title="On the card">
          {usedByLine(key)}
          {extra}
        </PreviewCard>
      }
    >
      <ColourField
        id={`idcard-${key}`}
        value={form[key]}
        onChange={(v) => set(key, v)}
        noun={text(metaId).title.toLowerCase()}
        disabled={disabled}
        fallback={DEFAULT_TEMPLATE[key].toLowerCase()}
      />
    </SettingBlock>
  );

  const whiteOnPrimary = isHexColour(form.primaryColor) ? contrastRatio(form.primaryColor, "#ffffff") : null;
  const textOnWhite = isHexColour(form.textColor) ? contrastRatio(form.textColor, "#ffffff") : null;
  const fontLoaded = LOADED_FONTS.includes(form.fontFamily);

  return (
    <div className="space-y-4">
      <SettingsSection
        icon={CreditCard}
        title="Employee ID Card Template"
        purpose="The colours, typeface and layout of the employee ID card. Cards are never stored: each time one is shown, downloaded, printed or sent it is drawn again from this template, so a change reaches every card at once, older ones included."
        usedBy={[
          { label: "ID Cards", to: "/hr/id-cards" },
          { label: "Employee Mobile App" },
          { label: "Employee Web App" },
          { label: "ID card emails and WhatsApp" },
        ]}
        testId="idcard-template"
      >
        <PreviewCard
          title="The card with this template"
          scenario="A made-up employee, drawn by the same code as the ID Cards page from the settings below as they are typed, with the company name, address, logo and signature saved on the Company and Salary Slip tabs."
          testId="idcard-preview"
        >
          <div role="radiogroup" aria-label="Card to show" className="flex gap-1.5">
            {(
              [
                [false, "Staff card"],
                [true, "Production card"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={label}
                type="button"
                role="radio"
                aria-checked={production === value}
                onClick={() => setProduction(value)}
                className={cn(
                  "rounded-full px-3 py-1 text-xs font-semibold",
                  production === value ? "bg-blue-600 text-white" : "bg-white text-gray-600 ring-1 ring-slate-200",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-start gap-4 overflow-x-auto py-1" data-testid="idcard-faces">
            {production ? (
              <>
                <ProductionCardFront card={card} />
                <ProductionCardBack card={card} qr={qrs[card.code]} />
              </>
            ) : (
              <>
                <StaffCardFront card={card} />
                <StaffCardBack card={card} qr={qrs[card.code]} />
              </>
            )}
          </div>
        </PreviewCard>

        <div className="mt-3 overflow-x-auto" data-testid="idcard-honoured">
          <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-gray-400">
            Where each option is used
          </p>
          <table className="w-full min-w-[520px] text-left text-[12px]">
            <thead>
              <tr className="text-gray-500">
                <th className="py-1 pr-2 font-semibold">Option</th>
                {SURFACES.map((s) => (
                  <th key={s} className="px-2 py-1 text-center font-semibold">
                    {s}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {OPTION_ROWS.map((row) => (
                <tr key={row.key} className="border-t border-slate-100">
                  <td className="py-1 pr-2 font-medium text-gray-700">{row.label}</td>
                  {HONOURED[row.key].map((on, i) => (
                    <td key={SURFACES[i]} className="px-2 py-1 text-center">
                      {on ? (
                        <Check size={14} className="inline text-emerald-600" aria-label="used" />
                      ) : (
                        <Minus size={14} className="inline text-gray-300" aria-label="not used" />
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1.5 text-[12px] leading-snug text-gray-500">
            The Employee Web App draws its own blue card (only the QR switch is read) and the picture sent by email or
            WhatsApp always carries the QR code. The older employee profile card inside the portal does not use this
            template at all. Who may change it: anyone with edit access to the ID Cards page (it is not a Settings
            permission).
          </p>
        </div>
      </SettingsSection>

      <SettingsSection
        icon={Palette}
        title="Colours"
        purpose="Three colours, each a # and six letters or digits. The company documents and the portal theme have colours of their own."
      >
        {colourBlock(
          "primaryColor",
          "idcard-primary",
          whiteOnPrimary !== null && (
            <PreviewLine
              label="White text on this colour (company name, code)"
              result={`${contrastText(whiteOnPrimary)} ${whiteOnPrimary >= 3 ? "- readable" : "- hard to read"}`}
              tone={whiteOnPrimary >= 3 ? "good" : "warn"}
            />
          ),
        )}
        {colourBlock("secondaryColor", "idcard-secondary", null)}
        {colourBlock(
          "textColor",
          "idcard-text",
          textOnWhite !== null && (
            <PreviewLine
              label="This colour on the white card"
              result={`${contrastText(textOnWhite)} ${textOnWhite >= READABLE_RATIO ? "- readable" : "- hard to read when printed"}`}
              tone={textOnWhite >= READABLE_RATIO ? "good" : "warn"}
            />
          ),
        )}
      </SettingsSection>

      <SettingsSection icon={Type} title="Typeface and layout" purpose="Used only by the ID Cards page.">
        <SettingBlock
          {...text("idcard-font")}
          labelFor="idcard-font"
          affects={[
            {
              where: "ID Cards page",
              what: "all four card faces, and so the downloaded picture and the print",
              to: "/hr/id-cards",
            },
          ]}
          defaultText="Hanken Grotesk"
          note="The portal loads only Hanken Grotesk and Inter. Poppins and Roboto show only on a PC that has them installed; elsewhere the browser's default font is used, in the downloaded picture and the print too."
          preview={
            <PreviewCard title="On this PC">
              <p className="text-[18px] font-black text-gray-900" style={{ fontFamily: form.fontFamily }}>
                Priya Sharma
              </p>
              <PreviewLine
                label={form.fontFamily}
                result={fontLoaded ? "loaded by the portal on every PC" : "only if this PC has it installed"}
                tone={fontLoaded ? "good" : "warn"}
                testId="idcard-font-loaded"
              />
            </PreviewCard>
          }
        >
          <Select
            id="idcard-font"
            value={form.fontFamily}
            onChange={(v) => set("fontFamily", v)}
            disabled={disabled}
            options={[
              ["Hanken Grotesk", "Hanken Grotesk"],
              ["Inter", "Inter"],
              ["Poppins", "Poppins (if installed)"],
              ["Roboto", "Roboto (if installed)"],
            ]}
          />
        </SettingBlock>

        <SettingBlock
          {...text("idcard-background")}
          labelFor="idcard-background"
          affects={[
            {
              where: "ID Cards page",
              what: "the top band only (the card body stays white): gradient = primary to secondary, solid = primary, pattern = the gradient under a fine white dot grid",
              to: "/hr/id-cards",
            },
          ]}
          defaultText="Gradient"
          preview={<PreviewCard title="On the card">{usedByLine("backgroundStyle")}</PreviewCard>}
        >
          <Select
            id="idcard-background"
            value={form.backgroundStyle}
            onChange={(v) => set("backgroundStyle", v)}
            disabled={disabled}
            options={[
              ["gradient", "Gradient"],
              ["solid", "Solid"],
              ["pattern", "Pattern"],
            ]}
          />
        </SettingBlock>

        <SettingBlock
          {...text("idcard-logo-position")}
          labelFor="idcard-logo-position"
          affects={[
            {
              where: "ID Cards page",
              what: "left = the round logo badge beside the name and address; center = the logo above them, everything centred",
              to: "/hr/id-cards",
            },
          ]}
          defaultText="Left"
          preview={<PreviewCard title="On the card">{usedByLine("logoPosition")}</PreviewCard>}
        >
          <Select
            id="idcard-logo-position"
            value={form.logoPosition}
            onChange={(v) => set("logoPosition", v)}
            disabled={disabled}
            options={[
              ["left", "Left"],
              ["center", "Center"],
            ]}
          />
        </SettingBlock>

        <SettingBlock
          {...text("idcard-corners")}
          labelFor="idcard-corners"
          affects={[
            { where: "ID Cards page", what: "the card's outer corners and the photo frame", to: "/hr/id-cards" },
          ]}
          defaultText="Rounded"
          note="Match it to the shape of the card stock the cards are printed on."
          preview={<PreviewCard title="On the card">{usedByLine("cornerStyle")}</PreviewCard>}
        >
          <Select
            id="idcard-corners"
            value={form.cornerStyle}
            onChange={(v) => set("cornerStyle", v)}
            disabled={disabled}
            options={[
              ["rounded", "Rounded"],
              ["sharp", "Sharp"],
            ]}
          />
        </SettingBlock>
      </SettingsSection>

      <SettingsSection icon={ScanLine} title="Back of the card">
        <SettingBlock
          {...text("idcard-footer")}
          labelFor="idcard-footer"
          affects={[
            {
              where: "ID Cards page",
              what: "the last line under INSTRUCTIONS on the back of staff and production cards",
              to: "/hr/id-cards",
            },
          ]}
          defaultText="Blank"
          note={`Not shown on the front, in the employee apps or on the picture sent by email. The card has a fixed size, so the line is limited to ${FOOTER_MAX} characters.`}
          preview={
            <PreviewCard title="On the back">
              {usedByLine("footerText")}
              <PreviewLine
                label={form.footerText.trim() ? `"${form.footerText.trim()}"` : "No extra line"}
                result={`${form.footerText.trim().length}/${FOOTER_MAX}`}
                tone={footerTooLong ? "bad" : "neutral"}
              />
            </PreviewCard>
          }
        >
          <Input
            id="idcard-footer"
            value={form.footerText}
            disabled={disabled}
            maxLength={FOOTER_MAX}
            placeholder="e.g. Valid for the current calendar year"
            aria-invalid={footerTooLong ? true : undefined}
            onChange={(e) => set("footerText", e.target.value)}
            data-testid="input-idcard-footer"
          />
          {footerTooLong && (
            <p role="alert" className="text-xs font-medium text-red-600">
              At most {FOOTER_MAX} characters fit on the card.
            </p>
          )}
        </SettingBlock>

        <SettingBlock
          {...text("idcard-qr")}
          affects={[
            {
              where: "ID Cards page",
              what: 'the QR code and "SCAN TO VERIFY EMPLOYEE" on the back (the back re-flows without it)',
              to: "/hr/id-cards",
            },
            { where: "Employee Mobile App and Employee Web App", what: "the QR code on the back of the card" },
            { where: "Picture sent by email / WhatsApp", what: "not used: that picture always has the QR code" },
          ]}
          defaultText="On"
          note="Scanning opens the public page /verify/<employee code>: name, designation, department, status, photo and blood group, under the Salary Slip tab's company name. Switching the code off does not close that page."
          preview={<PreviewCard title="On the back">{usedByLine("showQrOnBack")}</PreviewCard>}
        >
          <ToggleField
            id="idcard-qr"
            checked={form.showQrOnBack}
            onChange={(v) => set("showQrOnBack", v)}
            onLabel="QR code on the back"
            offLabel="No QR code"
            disabled={disabled}
          />
        </SettingBlock>
      </SettingsSection>

      <SaveFooter
        dirty={dirty}
        saving={update.isPending}
        onSave={save}
        onDiscard={discard}
        saveLabel="Save ID Card Template"
        disabled={disabled || !dirty || Boolean(problem)}
        hint={
          !data
            ? "Loading the saved template…"
            : problem
              ? problem
              : dirty
                ? "You have changes that are not saved yet. Cards keep the saved template until you save."
                : undefined
        }
      />
    </div>
  );
}
