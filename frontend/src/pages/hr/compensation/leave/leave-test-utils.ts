import { act } from "react";
import { must } from "../harness";

// DOM helpers of the Compensation Leave render tests that the shared harness does not have: the kit's native selects and
// the kit's DataTable (its rows carry `data-row-key`, not a test id).

/** Picks a value of a native <select> (the kit's SelectFilter) as a person would. */
export function choose(testId: string, value: string) {
  const el = must(testId) as HTMLSelectElement;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

/** The keys of the rows a kit DataTable shows (`<testId>` is the table's wrapper). */
export const rowKeys = (testId: string): string[] =>
  [...document.body.querySelectorAll(`[data-testid="${testId}"] tbody tr[data-row-key]`)].map(
    (r) => r.getAttribute("data-row-key") ?? "",
  );

/** One row of a kit DataTable, by its key. */
export const rowOf = (testId: string, key: string | number): HTMLElement | null =>
  document.body.querySelector<HTMLElement>(`[data-testid="${testId}"] tbody tr[data-row-key="${key}"]`);

/** The last request made to a path, as its query parameters. */
export const lastQuery = (requests: string[], path: string): URLSearchParams | null => {
  const last = requests.filter((r) => r.split("?")[0] === path).at(-1);
  return last === undefined ? null : new URLSearchParams(last.split("?")[1] ?? "");
};
