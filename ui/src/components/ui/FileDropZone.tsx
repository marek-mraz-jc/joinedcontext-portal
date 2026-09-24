import { useState } from "react";
import type { ReactNode } from "react";
import { clsx } from "clsx";
import { buttonClass } from "./Button";
import { FilePicker } from "./FilePicker";

export interface FileDropZoneProps {
  /** The accessible name of the input: "Choose a bundle", not "Choose file". */
  label: string;
  /** The visible trigger's words. */
  button: string;
  /** Under the trigger: what files the zone takes. */
  hint?: ReactNode;
  accept?: string;
  multiple?: boolean;
  /** The files dropped or chosen; one unless `multiple`. */
  onFiles: (files: File[]) => void;
  /** Under the hint: what was taken. */
  children?: ReactNode;
}

/**
 * The Portal's one place to drop a file (T-2758, UI-16): a dashed zone that takes a file dragged
 * onto it, with the shared FilePicker inside it for the keyboard and for anybody who does not
 * drag. Two pages still showed the browser's own "Choose file / No file chosen" control.
 */
export function FileDropZone({
  label,
  button,
  hint,
  accept,
  multiple,
  onFiles,
  children,
}: FileDropZoneProps): React.JSX.Element {
  const [over, setOver] = useState(false);
  return (
    <div
      data-testid="file-drop-zone"
      className={clsx(
        "flex flex-col items-start gap-2 rounded-md border border-dashed p-4",
        over ? "border-primary bg-primary-soft" : "border-border bg-surface-subtle",
      )}
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        const files = Array.from(event.dataTransfer.files);
        if (files.length > 0) {
          onFiles(multiple ? files : files.slice(0, 1));
        }
      }}
    >
      <FilePicker label={label} accept={accept} multiple={multiple} onFiles={onFiles}>
        <span className={buttonClass("secondary", "md", "cursor-pointer")}>{button}</span>
      </FilePicker>
      {hint ? <p className="text-caption text-fg-muted">{hint}</p> : null}
      {children}
    </div>
  );
}
