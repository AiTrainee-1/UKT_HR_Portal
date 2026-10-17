import { useState } from "react";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { checkOrigin, ORIGIN_EXAMPLES } from "./origin";
import { Notice, Problem } from "./ui";

/**
 * The websites whose pages may call the endpoint from a browser: add, change and remove, each checked with the server's own
 * rules before it is kept. The list is part of the endpoint's one Save.
 */
export function OriginsPanel({
  origins,
  onChange,
  readOnly,
  max,
  serverError,
}: {
  origins: string[];
  onChange: (next: string[]) => void;
  readOnly: boolean;
  max: number;
  serverError?: string;
}) {
  const [typed, setTyped] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ index: number; text: string; problem: string | null } | null>(null);

  const add = () => {
    setNote(null);
    const result = checkOrigin(typed);
    if (!result.ok) {
      setProblem(result.error);
      return;
    }
    setProblem(null);
    if (origins.includes(result.origin)) {
      setNote(`${result.origin} is already in the list.`);
      setTyped("");
      return;
    }
    if (origins.length >= max) {
      setProblem(`An endpoint can have ${max} allowed websites at most.`);
      return;
    }
    onChange([...origins, result.origin]);
    setTyped("");
  };

  const commitEdit = () => {
    if (!editing) return;
    const result = checkOrigin(editing.text);
    if (!result.ok) {
      setEditing({ ...editing, problem: result.error });
      return;
    }
    const others = origins.filter((_, i) => i !== editing.index);
    // changing a row to a website that is already listed collapses the two into one
    const next = origins.map((o, i) => (i === editing.index ? result.origin : o));
    onChange(others.includes(result.origin) ? others : next);
    setEditing(null);
  };

  return (
    <div className="space-y-3" data-testid="origins-panel">
      <p className="text-xs font-semibold text-slate-600" data-testid="origins-count">
        {origins.length} of {max} websites
      </p>

      {origins.length === 0 ? (
        <p className="text-sm text-slate-500" data-testid="origins-empty">
          No website is allowed yet, so browsers on every website are refused. Calls from your own servers (no origin)
          are decided by the switch below.
        </p>
      ) : (
        <ul className="space-y-1.5" data-testid="origins-list">
          {origins.map((origin, index) => (
            <li
              key={origin}
              className="rounded-lg border border-slate-200 px-3 py-2"
              data-testid="origin-row"
              data-origin={origin}
            >
              {editing?.index === index ? (
                <div className="space-y-1.5">
                  <label htmlFor="es-origin-edit" className="text-xs font-semibold text-gray-700">
                    Change {origin}
                  </label>
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      id="es-origin-edit"
                      value={editing.text}
                      autoFocus
                      className="min-w-0 flex-1 basis-56 font-mono"
                      aria-invalid={editing.problem ? true : undefined}
                      onChange={(e) => setEditing({ ...editing, text: e.target.value, problem: null })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          commitEdit();
                        } else if (e.key === "Escape") setEditing(null);
                      }}
                    />
                    <Button
                      type="button"
                      size="sm"
                      onClick={commitEdit}
                      className="gap-1"
                      aria-label="Keep this change"
                    >
                      <Check size={13} /> Keep
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditing(null)}
                      aria-label="Cancel this change"
                    >
                      <X size={13} /> Cancel
                    </Button>
                  </div>
                  {editing.problem && <Problem testId="origin-edit-error">{editing.problem}</Problem>}
                </div>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0 break-all font-mono text-[13px] text-slate-900">{origin}</span>
                  {!readOnly && (
                    <span className="flex gap-1">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="gap-1"
                        aria-label={`Change ${origin}`}
                        onClick={() => setEditing({ index, text: origin, problem: null })}
                      >
                        <Pencil size={12} /> Change
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="gap-1 text-red-700"
                        aria-label={`Remove ${origin}`}
                        onClick={() => onChange(origins.filter((o) => o !== origin))}
                      >
                        <Trash2 size={12} /> Remove
                      </Button>
                    </span>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {!readOnly && (
        <div className="space-y-1.5">
          <label htmlFor="es-origin-add" className="text-xs font-semibold text-gray-700">
            Add a website
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id="es-origin-add"
              value={typed}
              placeholder="https://intranet.example.com"
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={problem ? true : undefined}
              className="min-w-0 flex-1 basis-56 font-mono"
              onChange={(e) => {
                setTyped(e.target.value);
                setProblem(null);
                setNote(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  add();
                }
              }}
            />
            <Button type="button" size="sm" onClick={add} className="gap-1" data-testid="origin-add">
              <Plus size={13} /> Add
            </Button>
          </div>
          {problem && <Problem testId="origin-error">{problem}</Problem>}
          {note && (
            <p className="text-xs text-slate-600" data-testid="origin-note">
              {note}
            </p>
          )}
        </div>
      )}
      {serverError && <Problem testId="origins-error">{serverError}</Problem>}

      <details className="rounded-lg border border-slate-200 p-3" data-testid="origin-examples">
        <summary className="cursor-pointer text-[13px] font-semibold text-slate-800">What an origin looks like</summary>
        <p className="mt-2 text-xs leading-snug text-slate-600">
          An origin is the scheme, the website name and, if it is not the usual one, the port. Nothing else.
        </p>
        <ul className="mt-2 space-y-1">
          {ORIGIN_EXAMPLES.map((ex) => (
            <li key={ex.value} className="flex flex-wrap items-baseline gap-x-2 text-xs" data-valid={ex.valid}>
              <span className={ex.valid ? "font-bold text-emerald-700" : "font-bold text-red-700"}>
                {ex.valid ? "OK" : "Not allowed"}
              </span>
              <code className="break-all font-mono text-slate-900">{ex.value}</code>
              <span className="text-slate-500">{ex.note}</span>
            </li>
          ))}
        </ul>
      </details>

      <Notice tone="warn" title="Origins protect browsers. They are not a password." testId="origins-honesty">
        A website on this list can call the endpoint from a visitor's browser, and other websites cannot. But a program
        on a server can send any origin it likes. What really protects the data is the API key. So never put a key in a
        web page's code, where anyone can read it: let your own server make the call instead.
      </Notice>
    </div>
  );
}
