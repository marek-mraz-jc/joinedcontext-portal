import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";

// AppShell names the page's language and title on the document (T-3577); one test's shell must
// not decide the language the next test's components read from it.
afterEach(() => {
  if (typeof document === "undefined") return; // a node-environment file
  document.documentElement.removeAttribute("lang");
  document.title = "";
});
