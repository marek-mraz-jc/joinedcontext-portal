import { useEffect, useState } from "react";
import { Field, Input } from "../../components/ui";

/**
 * A name edited in place: what is typed is applied on Enter or on leaving the box, so a half-typed
 * name renames nothing. A name the model refuses goes back to the one it had; the editor says why.
 */
export function NameField({
  id,
  label,
  help,
  name,
  readOnly,
  onRename,
}: {
  id: string;
  label: string;
  help: string;
  name: string;
  readOnly?: boolean;
  onRename: (to: string) => boolean;
}): React.JSX.Element {
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [name]);
  const commit = () => {
    const to = draft.trim();
    if (to === name) return;
    if (to === "" || !onRename(to)) setDraft(name);
  };
  return (
    <Field id={id} label={label} help={help}>
      <Input
        id={id}
        className="font-mono"
        value={draft}
        readOnly={readOnly}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
        }}
      />
    </Field>
  );
}
