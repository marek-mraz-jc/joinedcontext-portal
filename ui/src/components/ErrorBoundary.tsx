import { Component } from "react";
import type { ErrorInfo, JSX, ReactNode } from "react";
import i18n from "../i18n";
import { Button, buttonClass } from "./ui/Button";

/**
 * UI-45, UI-46: the page a render error leaves behind.
 *
 * Without one of these React unmounts the whole tree, and a person is left with a white page and
 * nothing to do or to report. This shows words, a reference they can quote, and the two things
 * that ever help: load the page again, or go back to the start.
 *
 * What it does not show is as much of the point. An error message carries whatever threw it — a
 * URL with a token in its query, a response body, a stack naming the build — so none of it
 * reaches the page. The reference is the tie to the console line, where a developer with the
 * browser open already has the real error.
 */

/** i18n may itself be what failed; the English stays as the floor under it. */
function say(key: string, fallback: string): string {
  try {
    return i18n.t(key, { defaultValue: fallback });
  } catch {
    return fallback;
  }
}

/** Short enough to read out over a telephone, long enough not to collide within a day. */
function reference(): string {
  try {
    return crypto.randomUUID().slice(0, 8);
  } catch {
    return Date.now().toString(36);
  }
}

interface State {
  reference: string | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { reference: null };

  static getDerivedStateFromError(): State {
    return { reference: reference() };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The console is the developer's surface, not the page's: React logs the error and the
    // component stack there already, and this ties them to what the person is reading.
    console.error(`Portal error ${this.state.reference ?? ""}`, error, info.componentStack);
  }

  override render(): ReactNode {
    const { reference: id } = this.state;
    if (id === null) {
      return this.props.children;
    }
    return <ErrorPage reference={id} />;
  }
}

function ErrorPage({ reference: id }: { reference: string }): JSX.Element {
  return (
    <main className="mx-auto flex max-w-lg flex-col gap-4 p-8" role="alert" aria-live="assertive">
      <h1 className="text-xl font-semibold">{say("app.error.crashTitle", "This page stopped")}</h1>
      <p className="text-fg-muted">
        {say(
          "app.error.crashBody",
          "Something in the Portal failed while drawing this page. Nothing you were looking at was changed.",
        )}
      </p>
      <p className="text-sm text-fg-muted">
        {say("app.error.crashReference", "Quote this when you report it:")}{" "}
        <code data-testid="error-reference">{id}</code>
      </p>
      <div className="flex gap-2">
        <Button
          variant="primary"
          onClick={() => {
            window.location.reload();
          }}
        >
          {say("app.error.crashReload", "Load the page again")}
        </Button>
        <a className={buttonClass("secondary")} href="/">
          {say("app.error.crashHome", "Go to the start")}
        </a>
      </div>
    </main>
  );
}
