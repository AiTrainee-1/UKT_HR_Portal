// Toggle switch supplied by the user (styled-components snippet) -ported to
// plain CSS classes in index.css since this codebase has no styled-components
// dependency (same approach as SpeederLoader.tsx), rescaled for compact
// inline use, and made controlled (checked/onChange/id) for list contexts
// where multiple instances render at once.
export function MarbleSwitch({
  checked, onChange, id, title, disabled,
}: {
  checked: boolean;
  onChange: () => void;
  id: string;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <div className="ukt-switch-wrap" title={title}>
      <input
        className="ukt-switch-input"
        type="checkbox"
        id={id}
        checked={checked}
        onChange={onChange}
        disabled={disabled}
      />
      <label className="ukt-switch-label" htmlFor={id} />
      <span className="ukt-switch-marbles" />
    </div>
  );
}
