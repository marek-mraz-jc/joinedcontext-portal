import { render, screen } from "@testing-library/react";
import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import { OtherPageCrumb } from "../src/components/layout/Shell";

/** The crumb inside a router, as the shell renders it. */
async function crumb(model: string | undefined) {
  render(
    <RouterProvider
      router={createRouter({
        routeTree: createRootRoute({
          component: () => <OtherPageCrumb project="helsinki" label="Data models" model={model} />,
        }),
        history: createMemoryHistory({ initialEntries: ["/projects/helsinki/models/x"] }),
      })}
    />,
  );
  await screen.findByText("Data models");
}

describe("OtherPageCrumb", () => {
  it("names the page without a link outside a model", async () => {
    await crumb(undefined);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Data models")).toHaveAttribute("aria-current", "page");
  });

  it("links back to the models of a new model and names nothing else", async () => {
    await crumb("");
    expect(screen.getByRole("link", { name: "Data models" })).toHaveAttribute("href", "/projects/helsinki/models");
    expect(document.querySelector('span[aria-current="page"]')).toBeNull();
  });

  it("links back to the models and names the model", async () => {
    await crumb("air-quality");
    expect(screen.getByRole("link", { name: "Data models" })).toHaveAttribute("href", "/projects/helsinki/models");
    expect(screen.getByText("air-quality")).toHaveAttribute("aria-current", "page");
  });
});
