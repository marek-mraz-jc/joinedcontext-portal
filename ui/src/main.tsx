import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { i18nReady } from "./i18n";
import "./index.css";
import { App } from "./App";
import { ErrorBoundary, mayReloadForChunk } from "./components/ErrorBoundary";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

// The chosen language loads before the first paint, so nobody sees the page flip from English.
void i18nReady.then(() =>
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
          <App />
        </ErrorBoundary>
      </QueryClientProvider>
    </StrictMode>,
  ),
);
