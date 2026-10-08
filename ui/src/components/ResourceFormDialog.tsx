import { Suspense, lazy } from "react";
import type { JSX } from "react";
import type { ResourceFormDialogProps } from "./ResourceFormDialogBody";

export type { ManifestSource, ResourceFormDialogProps } from "./ResourceFormDialogBody";

// The form engine, the shipped forms and their widgets load when a create dialog opens, not with
// every page that offers New (T-3316).
const ResourceFormDialogBody = lazy(() =>
  import("./ResourceFormDialogBody").then((module) => ({ default: module.ResourceFormDialogBody })),
);

/** A create dialog: the kind's form, rendered once it is open (see ResourceFormDialogBody). */
export function ResourceFormDialog<T>(props: ResourceFormDialogProps<T>): JSX.Element | null {
  return props.open ? (
    <Suspense fallback={null}>
      <ResourceFormDialogBody {...(props as ResourceFormDialogProps<unknown>)} />
    </Suspense>
  ) : null;
}
