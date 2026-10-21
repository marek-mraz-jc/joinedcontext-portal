import { retainSearchParams } from "@tanstack/react-router";

/**
 * Inside a copy every in-app link stays in it (T-4868): a link that does not name `workspace`
 * carries the current one. Without this the pipeline page's Edit opened the editor outside the
 * copy and its Propose went to the project, while the person still thought they were in the copy.
 */
export const keepCopy = retainSearchParams<{ workspace?: string }>(["workspace"]);

