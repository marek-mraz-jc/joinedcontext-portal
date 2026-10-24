import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { i18nReady, loadFullLocales } from "./i18n";
import "./index.css";
import { ErrorBoundary, mayReloadForChunk } from "./components/ErrorBoundary";
import { PublicApp } from "./PublicApp";
import { isPublicPath } from "./publicRouter";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

// A page anybody may open boots its own small router (T-5122); every other address loads the full
// Portal and every word of the chosen language first.
const portal = isPublicPath(window.location.pathname)
  ? Promise.resolve(PublicApp)
  : Promise.all([import("./App"), i18nReady.then(loadFullLocales)]).then(([module]) => module.App);

// The chosen language loads before the first paint, so nobody sees the page flip from English.
void Promise.all([portal, i18nReady]).then(([Portal]) =>
  createRoot(document.getElementById("root")!, {
    // React logs every error a boundary caught; a missing chunk after a rollout reloads the page
    // instead (T-4949), so it is no error to report. Every other one is logged as React does.
    onCaughtError: (error, info) => {
      if (!mayReloadForChunk(error)) console.error(error, info.componentStack);
    },
  }).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        {/* Outside the App and inside the providers: a render error anywhere below leaves a page
          with words and a reference on it rather than the white one React unmounts to. */}
        <ErrorBoundary>
          <Portal />
        </ErrorBoundary>
      </QueryClientProvider>
    </StrictMode>,
  ),
);
