import { useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Field, ToggleField } from "../kit/Field";
import { SettingBlock } from "../kit/SettingBlock";
import { slugify, publicUrl } from "./form";
import { CodeBox } from "./ui";
import type { SectionProps } from "./sectionProps";

/** Basics: what the endpoint is called, where it lives and whether it answers at all. */
export function BasicsSection({ draft, patch, readOnly, errors, creating, savedEnabled, origin }: SectionProps) {
  const [confirmingOff, setConfirmingOff] = useState(false);
  const addressRef = useRef<HTMLInputElement>(null);
  const url = publicUrl(origin, draft.slug);

  return (
    <div className="space-y-1" data-testid="endpoint-basics">
      <SettingBlock
        id="basics-name"
        labelFor="es-name"
        title="Name"
        purpose="A name for people, so you remember what this endpoint is for, for example Departments for the intranet. It is never shown to the other application."
      >
        <Field label="Name" htmlFor="es-name" error={errors.name}>
          <Input
            id="es-name"
            value={draft.name}
            maxLength={120}
            disabled={readOnly}
            aria-invalid={errors.name ? true : undefined}
            onChange={(e) => {
              const name = e.target.value;
              patch(creating && !draft.slugTouched ? { name, slug: slugify(name) } : { name });
            }}
          />
        </Field>
      </SettingBlock>

      <SettingBlock
        id="basics-address"
        labelFor="es-slug"
        title="Address"
        purpose="The last part of the web address the other application calls. It is chosen once and can never be changed, because other applications will have it written into their code."
        note={
          creating
            ? "Use small letters a to z, digits and hyphens, 3 to 60 characters. Choose it carefully: it cannot be changed later."
            : undefined
        }
      >
        <Field label="Address" htmlFor="es-slug" error={errors.slug}>
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 text-xs font-semibold text-slate-500">/api/shared/</span>
            <Input
              id="es-slug"
              ref={addressRef}
              value={draft.slug}
              maxLength={60}
              readOnly={!creating}
              disabled={readOnly && creating}
              aria-invalid={errors.slug ? true : undefined}
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              className="min-w-0 font-mono"
              onChange={(e) => patch({ slug: e.target.value.toLowerCase(), slugTouched: true })}
            />
          </div>
        </Field>
        <CodeBox label="The full address (GET)" code={url} testId="endpoint-url" copyLabel="Copy address" />
      </SettingBlock>

      <SettingBlock
        id="basics-description"
        labelFor="es-description"
        title="Description"
        purpose="Optional notes for your colleagues: which application uses this endpoint and who asked for it."
      >
        <Textarea
          id="es-description"
          rows={3}
          value={draft.description}
          maxLength={500}
          disabled={readOnly}
          onChange={(e) => patch({ description: e.target.value })}
        />
      </SettingBlock>

      <SettingBlock
        id="basics-enabled"
        labelFor="es-enabled"
        title="Answering calls"
        purpose="When on, the endpoint answers calls that carry a valid key. When off, every call is answered as if the address did not exist, so nobody can tell it is there. Keys and settings are kept."
        defaultText="On (but it shares nothing until a key exists)"
        note={
          savedEnabled && !draft.enabled
            ? "Switching off takes effect when you save. Applications using this endpoint stop getting data at once."
            : undefined
        }
      >
        <ToggleField
          id="es-enabled"
          checked={draft.enabled}
          disabled={readOnly}
          onChange={(next) => {
            if (!next && savedEnabled) setConfirmingOff(true);
            else patch({ enabled: next });
          }}
          onLabel="The endpoint answers calls"
          offLabel="The endpoint is switched off"
        >
          Calls need a valid key either way.
        </ToggleField>
      </SettingBlock>

      <AlertDialog open={confirmingOff} onOpenChange={setConfirmingOff}>
        <AlertDialogContent data-testid="confirm-switch-off">
          <AlertDialogHeader>
            <AlertDialogTitle>Switch this endpoint off?</AlertDialogTitle>
            <AlertDialogDescription>
              After you save, every call to it is answered as "not found", including calls with a valid key.
              Applications that use it stop getting data. Nothing is deleted: you can switch it on again at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it on</AlertDialogCancel>
            <AlertDialogAction
              data-testid="confirm-switch-off-yes"
              onClick={() => {
                patch({ enabled: false });
                setConfirmingOff(false);
              }}
            >
              Switch it off
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
