import type { SettingMeta } from "../kit/catalog";

/** The title and purpose a setting's block shows: the same words the page's search runs on (`<Tab>.meta.ts`). */
export function metaOf(list: SettingMeta[], id: string): Pick<SettingMeta, "id" | "title" | "purpose"> {
  const meta = list.find((m) => m.id === id);
  if (!meta) throw new Error(`No setting "${id}" in this tab's meta list`);
  return meta;
}
