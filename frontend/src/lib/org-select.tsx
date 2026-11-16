// The option lists of a department / designation picker (lib/departments.ts builds the options): one kind is a plain
// list; both kinds sit under "Staff" and "Production" headings, so same-named departments can be told apart.

import { SelectGroup, SelectItem, SelectLabel } from "@/components/ui/select";
import { ORG_CATEGORIES, ORG_CATEGORY_LABEL, hasBothCategories, type OrgChoice } from "@/lib/departments";

/** The items of a shadcn <Select> (put an "All" item of your own before it). */
export function OrgSelectItems({ options, testIdPrefix }: { options: readonly OrgChoice[]; testIdPrefix?: string }) {
  const item = (o: OrgChoice) => (
    <SelectItem key={o.value} value={o.value} data-testid={testIdPrefix ? `${testIdPrefix}-${o.value}` : undefined}>
      {o.label}
    </SelectItem>
  );
  if (!hasBothCategories(options)) return <>{options.map(item)}</>;
  return (
    <>
      {ORG_CATEGORIES.map((c) => {
        const items = options.filter((o) => o.category === c);
        if (!items.length) return null;
        return (
          <SelectGroup key={c} data-testid={testIdPrefix ? `${testIdPrefix}-group-${c}` : undefined}>
            <SelectLabel className="pl-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {ORG_CATEGORY_LABEL[c]}
            </SelectLabel>
            {items.map(item)}
          </SelectGroup>
        );
      })}
    </>
  );
}

/** The <option>s of a native <select>, in <optgroup>s when both kinds are offered. */
export function OrgNativeOptions({ options }: { options: readonly OrgChoice[] }) {
  const item = (o: OrgChoice) => (
    <option key={o.value} value={o.value}>
      {o.label}
    </option>
  );
  if (!hasBothCategories(options)) return <>{options.map(item)}</>;
  return (
    <>
      {ORG_CATEGORIES.map((c) => {
        const items = options.filter((o) => o.category === c);
        return items.length ? (
          <optgroup key={c} label={ORG_CATEGORY_LABEL[c]}>
            {items.map(item)}
          </optgroup>
        ) : null;
      })}
    </>
  );
}
