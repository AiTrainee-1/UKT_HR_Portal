import { useRef, useState, type KeyboardEvent } from "react";
import { GUIDE_LANGUAGES, type SharedGuideExample } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { CodeBox } from "./ui";

const rank = (language: string) => {
  const i = (GUIDE_LANGUAGES as readonly string[]).indexOf(language);
  return i === -1 ? GUIDE_LANGUAGES.length : i;
};

/** The same call in several languages: a language switcher (a real tablist) and the code of the chosen one with a copy button. */
export function CodeExamples({
  examples,
  testId = "code-examples",
}: {
  examples: SharedGuideExample[];
  testId?: string;
}) {
  const ordered = [...examples].sort((a, b) => rank(a.language) - rank(b.language));
  const [chosen, setChosen] = useState(ordered[0]?.language ?? "");
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  if (ordered.length === 0) {
    return (
      <p className="text-sm text-slate-500" data-testid={`${testId}-empty`}>
        No examples came with this guide.
      </p>
    );
  }
  const active = Math.max(
    0,
    ordered.findIndex((e) => e.language === chosen),
  );
  const current = ordered[active];

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let to = index;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") to = (index + 1) % ordered.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") to = (index - 1 + ordered.length) % ordered.length;
    else if (event.key === "Home") to = 0;
    else if (event.key === "End") to = ordered.length - 1;
    else return;
    event.preventDefault();
    buttons.current[to]?.focus();
    setChosen(ordered[to].language);
  };

  return (
    <div className="space-y-2" data-testid={testId}>
      <div className="max-w-full overflow-x-auto">
        <div
          role="tablist"
          aria-label="Language of the example"
          className="flex w-max gap-1"
          data-testid={`${testId}-languages`}
        >
          {ordered.map((e, index) => {
            const on = index === active;
            return (
              <button
                key={e.language}
                ref={(el) => {
                  buttons.current[index] = el;
                }}
                type="button"
                role="tab"
                aria-selected={on}
                tabIndex={on ? 0 : -1}
                id={`${testId}-tab-${e.language}`}
                aria-controls={`${testId}-panel`}
                data-testid={`${testId}-lang-${e.language}`}
                onClick={() => setChosen(e.language)}
                onKeyDown={(event) => onKeyDown(event, index)}
                className={cn(
                  "rounded-full px-3 py-1 text-xs font-semibold outline-none ring-1 transition-colors focus-visible:ring-2 focus-visible:ring-indigo-500",
                  on
                    ? "bg-indigo-600 text-white ring-indigo-600"
                    : "bg-white text-slate-600 ring-slate-200 hover:text-slate-900",
                )}
              >
                {e.label}
              </button>
            );
          })}
        </div>
      </div>
      <div
        role="tabpanel"
        id={`${testId}-panel`}
        aria-labelledby={`${testId}-tab-${current.language}`}
        data-language={current.language}
      >
        <CodeBox code={current.code} label={`${current.label} example`} testId={`${testId}-code`} />
      </div>
    </div>
  );
}
