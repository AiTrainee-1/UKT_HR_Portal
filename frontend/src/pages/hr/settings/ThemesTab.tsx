import { useEffect, useState } from "react";
import { Eye, GitBranch, Monitor, Palette, SlidersHorizontal, SwatchBook } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useTheme } from "@/contexts/ThemeContext";
import { usePayrollSettings } from "@/lib/api-client/custom-hooks";
import { THEMES, type ThemeId } from "@/lib/themes";
import { ManagedElsewhere, PreviewCard, PreviewLine, SettingBlock, SettingsSection } from "./kit/SettingBlock";
import { THEMES_SETTINGS } from "./ThemesTab.meta";
import { everyoneText, statusOf } from "./themes/status";
import { errorText } from "./identity/errors";
import { metaOf } from "./identity/meta";
import { CustomizeDialog } from "./themes/CustomizeDialog";
import { EDITABLE, editableOf, hex, LIGHT_TEXT, TEXT_ON } from "./themes/palettes";
import { tokenText } from "./themes/text";
import { ThemeCard } from "./themes/ThemeCard";

const labelOf = (id: ThemeId) => THEMES.find((t) => t.id === id)?.label ?? id;
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/**
 * Settings -> Themes: the colour scheme of the whole portal frontend, for every user. The choice is saved on the
 * server (PayrollSettings.theme_name / theme_custom) the moment a theme is switched on, and ThemeContext applies it as
 * data-theme on <html> (src/index.css, and src/themes/clean/ for Clean Professional) with the custom colours as inline
 * tokens. "Use only on this device" keeps a theme of its own in this browser (never sent to the server); it wins over
 * the theme for everyone on this device until it is cleared.
 */
export default function ThemesTab({ readOnly = false }: { readOnly?: boolean }) {
  const { toast } = useToast();
  const {
    theme,
    deviceTheme,
    effectiveTheme,
    appliedTheme,
    orgThemeState,
    isPreviewing,
    custom,
    preview,
    save,
    setDeviceTheme,
    isSaving,
  } = useTheme();
  const { data: settings } = usePayrollSettings();
  const [customizing, setCustomizing] = useState(false);
  const [pending, setPending] = useState<ThemeId | null>(null);

  // A theme has no branch copy: the server refuses a branch login's save, so the switches are off for one.
  const branchLogin = settings?.companyWideRulesEditable === false;
  const locked = readOnly || branchLogin;
  const saved = editableOf(custom);
  const savedCount = Object.keys(saved).length;
  const activeLabel = labelOf(theme);

  // Leaving the page with a preview still showing would be confusing: back to the saved theme on unmount.
  useEffect(() => () => preview(null, null), [preview]);

  const activate = async (id: ThemeId) => {
    setPending(null);
    try {
      // Custom colours belong to the theme they were picked on; another theme starts from its own palette.
      await save(id, id === theme ? custom : {});
      toast({
        title: "Theme applied",
        description: `${labelOf(id)} is now active for everyone.${
          id !== theme && savedCount > 0
            ? ` The ${plural(savedCount, "custom colour")} of ${activeLabel} were dropped.`
            : ""
        }`,
      });
    } catch (e) {
      toast({ title: "Failed to apply theme", description: errorText(e), variant: "destructive" });
    }
  };

  // Switching away from a theme that has custom colours loses them, so that is asked first.
  const askActivate = (id: ThemeId) => {
    if ((id === theme && orgThemeState === "confirmed") || locked) return;
    if (savedCount > 0) setPending(id);
    else void activate(id);
  };

  // Preview a theme exactly as switching it on would show it: another theme without this one's custom colours.
  const previewTheme = (id: ThemeId) => preview(id, id === theme ? null : {});

  // "Use only on this device" is this browser's own setting: it changes nothing on the server and nobody else's screen,
  // so it stays available to a view-only role and a branch login. Choosing it ends a preview (the choice is what shows).
  const followEveryone = () => {
    setDeviceTheme(null);
    toast({
      title: "This device follows everyone again",
      description: `This device now shows ${labelOf(theme)}, the theme set for everyone.`,
    });
  };
  const chooseForDevice = (id: ThemeId) => {
    preview(null, null);
    if (deviceTheme === id) {
      followEveryone();
      return;
    }
    setDeviceTheme(id);
    toast({
      title: "Theme set for this device",
      description: `${labelOf(id)} is now used on this device only. Nobody else's screen changes.`,
    });
  };

  return (
    <div className="space-y-4">
      {isPreviewing && (
        <div
          className="settings-glass flex flex-wrap items-center justify-between gap-2 rounded-2xl px-3.5 py-2.5 text-[12px] font-semibold text-amber-900 !bg-amber-50/70"
          data-testid="theme-previewing"
        >
          <span className="flex items-center gap-1.5">
            <Eye size={14} /> Previewing {labelOf(effectiveTheme)} on your screen only - nothing is saved until you
            switch a theme on.
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-[11px]"
            onClick={() => preview(null, null)}
            data-view-safe
          >
            Stop preview
          </Button>
        </div>
      )}

      {branchLogin && (
        <div
          className="flex items-start gap-2 rounded-xl border border-violet-200 bg-violet-50 px-3 py-2.5 text-[12px] leading-snug text-violet-900"
          data-testid="theme-branch-note"
        >
          <GitBranch size={14} className="mt-0.5 shrink-0" />
          <span>
            <b>You are signed in with a branch login.</b> The theme is company-wide and has no branch copy, so only an
            administrator or a login without a branch can change it. You can still preview any theme on your own screen,
            or use one on this device only.
          </span>
        </div>
      )}

      <SettingsSection
        icon={Palette}
        title="Themes"
        purpose="The look every page of this portal is drawn in, for every user at once. Preview a theme on your own screen first, then switch it on - or use it only on this device. The Employee Mobile App and the Employee Web App are not themed."
        usedBy={[
          { label: "HR portal pages" },
          { label: "Employee pages in the portal" },
          { label: "Sign-in pages", to: "/employee-login" },
          { label: "MD portal (custom colours only)" },
        ]}
        testId="themes-section"
      >
        <SettingBlock
          {...metaOf(THEMES_SETTINGS, "theme-active")}
          affects={[
            {
              where: "Every HR portal page",
              what: "the page background, cards, text, switches, badges, links and highlights take the theme's colours. In the colour themes the main blue buttons and the left menu keep their fixed look; Clean Professional redraws them too, flat",
            },
            {
              where: "Employee pages inside the portal and the sign-in pages",
              what: "the same colours (a sign-in page shows the copy this browser kept from its last visit; a browser that never signed in shows the Default Theme)",
              to: "/employee-login",
            },
            { where: "MD portal", what: "keeps its own skin in every theme; only custom colours reach it" },
            { where: "Activity log", what: 'an entry "Changed portal theme to ..." each time' },
          ]}
          defaultText="Default Theme"
          note="Not changed by a theme: the Employee Mobile App, the Employee Web App, PDFs, ID cards and emails, which have colours of their own. Switching to another theme drops any custom colours set on this one."
        >
          <div className="grid gap-3 sm:grid-cols-2" data-testid="theme-cards">
            {THEMES.map((t) => {
              // each label has one source: the server (everyone), localStorage (this device), <html data-theme> (showing)
              const st = statusOf(t.id, {
                org: theme,
                orgState: orgThemeState,
                device: deviceTheme,
                applied: appliedTheme,
                previewing: isPreviewing,
              });
              return (
                <ThemeCard
                  key={t.id}
                  def={t}
                  active={st.everyone}
                  device={st.device}
                  showing={st.showing}
                  custom={custom}
                  disabled={locked || isSaving}
                  onActivate={() => askActivate(t.id)}
                  onPreview={() => previewTheme(t.id)}
                  onUseOnDevice={() => chooseForDevice(t.id)}
                  onCustomize={() => setCustomizing(true)}
                >
                  {pending === t.id && (
                    <div
                      className="space-y-1.5 rounded-xl bg-amber-50/80 px-2.5 py-2 text-[11px] font-medium leading-snug text-amber-900 ring-1 ring-amber-200"
                      role="alert"
                      data-testid="theme-switch-confirm"
                    >
                      <p>
                        Switching to {t.label} drops the {plural(savedCount, "custom colour")} set on {activeLabel};
                        they cannot be brought back.
                      </p>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          className="h-7 text-[11px]"
                          onClick={() => void activate(t.id)}
                          disabled={isSaving}
                        >
                          Switch anyway
                        </Button>
                        <Button variant="ghost" size="sm" className="h-7 text-[11px]" onClick={() => setPending(null)}>
                          Keep {activeLabel}
                        </Button>
                      </div>
                    </div>
                  )}
                </ThemeCard>
              );
            })}
          </div>
        </SettingBlock>

        <SettingBlock
          {...metaOf(THEMES_SETTINGS, "theme-device")}
          affects={[
            {
              where: "This browser only",
              what: "every HR portal page, the employee pages in the portal and this device's sign-in pages draw in the theme chosen for it",
            },
            { where: "Everyone else", what: "nothing changes: they keep the theme set for everyone" },
            { where: "MD portal", what: "keeps its own skin in every theme" },
          ]}
          defaultText="Follows the theme set for everyone"
          note="The choice is kept in this browser only: another browser, another computer or a cleared browser follows everyone again. A device on another theme shows that theme as it comes, without the custom colours set for everyone."
          preview={
            <PreviewCard title="Who sees what" scenario="The theme drawn on each screen right now.">
              <PreviewLine
                label="Everyone (saved on the server)"
                result={everyoneText(labelOf(theme), orgThemeState)}
                tone={orgThemeState === "confirmed" ? "neutral" : "warn"}
                testId="theme-everyone-line"
              />
              <PreviewLine
                label="This device (this browser only)"
                result={deviceTheme ? labelOf(deviceTheme) : "Same as everyone"}
                tone={deviceTheme ? "good" : "neutral"}
                testId="theme-device-line"
              />
              <PreviewLine
                label="Your screen right now"
                result={isPreviewing ? `${labelOf(appliedTheme)} (preview)` : labelOf(appliedTheme)}
                tone={isPreviewing ? "warn" : "info"}
                testId="theme-screen-line"
              />
            </PreviewCard>
          }
        >
          <div className="space-y-2">
            <p className="text-xs leading-snug text-gray-600" data-testid="theme-device-state">
              {deviceTheme ? (
                <>
                  This device uses <b>{labelOf(deviceTheme)}</b> on its own, whatever theme is set for everyone.
                </>
              ) : (
                <>
                  This device follows the theme set for everyone
                  {orgThemeState === "confirmed" ? (
                    <>
                      {" "}
                      (<b>{labelOf(theme)}</b>)
                    </>
                  ) : null}
                  .
                </>
              )}
            </p>
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              onClick={() => {
                preview(null, null);
                followEveryone();
              }}
              disabled={deviceTheme === null}
              data-view-safe
              data-testid="theme-device-clear"
            >
              <Monitor size={13} /> Follow everyone's theme again
            </Button>
            <p className="text-xs leading-snug text-gray-500">
              To pick a theme for this device, press <b>Use only on this device</b> on its card above.
            </p>
          </div>
        </SettingBlock>

        <SettingBlock
          {...metaOf(THEMES_SETTINGS, "theme-custom")}
          affects={EDITABLE.map((token) => ({
            where: tokenText(theme, token).label,
            what: tokenText(theme, token).colours,
          }))}
          defaultText="None: the theme's own colours"
          note="They belong to the theme they were picked on: switching to another theme drops them. Where a colour would leave its text unreadable, a readable text colour (white or near-black) is saved with it, because the matching text colours cannot be edited here."
          preview={
            <PreviewCard title="Colours in force" scenario={`What everyone sees on top of ${activeLabel} right now.`}>
              {savedCount === 0 ? (
                <PreviewLine
                  label="No custom colours"
                  result={`${activeLabel} as it comes`}
                  tone="neutral"
                  testId="custom-none"
                />
              ) : (
                EDITABLE.filter((token) => token in saved).map((token) => {
                  const on = TEXT_ON[token];
                  const textToken = on && custom[on.token];
                  return (
                    <PreviewLine
                      key={token}
                      label={
                        <span className="inline-flex items-center gap-1.5">
                          <span
                            className="inline-block h-3.5 w-3.5 rounded-full ring-1 ring-black/10"
                            style={{ background: `hsl(${saved[token]})` }}
                          />
                          {tokenText(theme, token).label}
                        </span>
                      }
                      result={`${hex(saved[token])}${
                        textToken ? ` with ${textToken === LIGHT_TEXT ? "white" : "near-black"} text` : ""
                      }`}
                      testId={`custom-${token.slice(2)}`}
                    />
                  );
                })
              )}
            </PreviewCard>
          }
        >
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={() => setCustomizing(true)}
            disabled={locked || isSaving}
            data-testid="theme-customize-open"
          >
            <SlidersHorizontal size={13} /> Customize {activeLabel}
          </Button>
          <p className="text-xs leading-snug text-gray-500">
            Opens the six colours of the active theme. Each pick shows on your screen at once; Save colours applies them
            to everyone, Reset to theme default removes them all.
          </p>
        </SettingBlock>
      </SettingsSection>

      <SettingsSection
        icon={SwatchBook}
        title="Colours set elsewhere"
        purpose="The theme colours the screen only. Printed and sent things have colours of their own, kept with the thing they colour."
      >
        <div className="grid gap-3 md:grid-cols-2">
          <ManagedElsewhere title="ID card colours" to="/hr/settings?tab=idcard" linkLabel="ID Card tab">
            The primary, secondary and text colours of employee ID cards, on the ID Cards page, in the Employee Mobile
            App and on the e-mailed card picture.
          </ManagedElsewhere>
          <ManagedElsewhere
            title="Letter and salary slip colours"
            to="/hr/settings?tab=documents"
            linkLabel="Company Documents"
          >
            The theme and accent colours of offer letters, experience letters, salary slips and resignation letters, one
            set per document.
          </ManagedElsewhere>
        </div>
      </SettingsSection>

      <CustomizeDialog open={customizing} onClose={() => setCustomizing(false)} themeId={theme} readOnly={locked} />
    </div>
  );
}
