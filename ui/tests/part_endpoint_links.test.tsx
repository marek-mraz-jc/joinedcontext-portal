/**
 * T-1812, T-1815: the endpoint link pill and the export trigger (UI-15, UI-16, PF-50).
 *
 * `EndpointLink` is the one control that turns a value into a link a steward hands out, and no
 * unit test named it. The survey measured its `href` as built from a value; it goes through
 * `safeHref`, and these cases are what holds it there — a scheme that runs code has to lose its
 * link and keep its words, in a pill that is still reachable and still says where it goes.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import {
  catalogueUrl,
  endpointUrl,
  EndpointLink,
  ENDPOINT_LINKS,
  REPRESENTATION_PATHS,
  servedRepresentations,
} from "../src/components/endpoints/links";
import { ExportButton } from "../src/components/export/ExportButton";

function wrap(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>{node}</I18nextProvider>
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the endpoint link pill", () => {
  it("links_the_address_the_portal_built_and_opens_it_away_from_this_page_safely", () => {
    wrap(<EndpointLink href={endpointUrl("k7m2qz4tv6xh3n5jb2ryd3wcfa", "/ngsi-ld/v1/types")}>types</EndpointLink>);
    const link = screen.getByRole("link", { name: /types/ });
    expect(link).toHaveAttribute("href", `${window.location.origin}/api/endpoint/k7m2qz4tv6xh3n5jb2ryd3wcfa/ngsi-ld/v1/types`);
    expect(link).toHaveAttribute("target", "_blank");
    // Without `rel`, the page it opens gets a handle on this one through `window.opener`.
    expect(link.getAttribute("rel")).toMatch(/noopener|noreferrer/);
    // The whole address as the tooltip: a pill is short, and a steward is about to paste it.
    expect(link).toHaveAttribute("title", expect.stringContaining("/api/endpoint/"));
  });

  it("keeps_the_words_and_withholds_the_link_for_a_scheme_that_could_run_code", () => {
    for (const href of ["javascript:alert(1)", "data:text/html,<script>1</script>", "vbscript:x"]) {
      const { unmount } = wrap(<EndpointLink href={href}>{href}</EndpointLink>);
      expect(screen.getByText(href)).toBeInTheDocument();
      expect(screen.queryByRole("link")).toBeNull();
      unmount();
    }
  });

  it("is_reached_by_the_keyboard_with_a_focus_ring_of_the_shared_kind", async () => {
    wrap(
      <>
        <EndpointLink href={endpointUrl("slug", "/file.csv")}>csv</EndpointLink>
        <EndpointLink muted href={endpointUrl("slug", "/access")}>
          access
        </EndpointLink>
      </>,
    );
    const links = screen.getAllByRole("link");
    for (const link of links) {
      expect(link).toHaveClass("focus-ring");
    }
    await userEvent.tab();
    expect(links[0]).toHaveFocus();
    await userEvent.tab();
    expect(links[1]).toHaveFocus();
  });

  it("every_representation_and_every_standing_link_is_a_path_under_the_endpoint", () => {
    // A path that escaped the endpoint's own prefix would be a link out of the slug's grants.
    for (const path of [...Object.values(REPRESENTATION_PATHS), ...ENDPOINT_LINKS.map((one) => one.path)]) {
      expect(path.startsWith("/"), path).toBe(true);
      expect(path).not.toContain("..");
      const url = new URL(endpointUrl("k7m2qz4tv6xh3n5jb2ryd3wcfa", path));
      expect(url.origin).toBe(window.location.origin);
      expect(url.pathname.startsWith("/api/endpoint/k7m2qz4tv6xh3n5jb2ryd3wcfa"), path).toBe(true);
    }
  });

  it("a_catalogue_address_escapes_the_name_it_is_given", () => {
    expect(catalogueUrl("air quality/../admin")).toBe(
      `https://data.${window.location.host}/dataset/air%20quality%2F..%2Fadmin`,
    );
  });
});

describe("what an endpoint serves", () => {
  // EP-10, EP-24, T-2901, T-2939: NGSI-LD, GeoJSON and MCP are on for every Endpoint, public or
  // internal, without being listed.
  it("adds_ngsi_ld_geojson_and_mcp_to_every_endpoint", () => {
    expect(servedRepresentations({ enabledRepresentations: ["ngsi-ld", "csv"] })).toEqual(["ngsi-ld", "csv", "geojson", "mcp"]);
    expect(servedRepresentations({ enabledRepresentations: ["mcp", "geojson", "ngsi-ld"] })).toEqual(["mcp", "geojson", "ngsi-ld"]);
    expect(servedRepresentations({})).toEqual(["ngsi-ld", "geojson", "mcp"]);
  });

  it("leaves_mcp_out_only_when_the_manifest_says_mcp_false", () => {
    expect(servedRepresentations({ enabledRepresentations: ["csv"], mcp: false })).toEqual(["csv", "ngsi-ld", "geojson"]);
    // Anything but the boolean false is not an opt-out: the gateway would serve the instance.
    expect(servedRepresentations({ enabledRepresentations: ["ngsi-ld"], mcp: "false" })).toEqual(["ngsi-ld", "geojson", "mcp"]);
  });

  it("drops_a_list_entry_that_is_not_a_name", () => {
    expect(servedRepresentations({ enabledRepresentations: ["ngsi-ld", 7, null], mcp: false })).toEqual(["ngsi-ld", "geojson"]);
    expect(servedRepresentations({ enabledRepresentations: "ngsi-ld" })).toEqual(["ngsi-ld", "geojson", "mcp"]);
  });
});

describe("the export trigger", () => {
  it("opens_the_dialog_from_the_keyboard_and_closes_it_back_onto_its_button", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ apiVersion: "joinedcontext.com/v1alpha1", kind: "List", items: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      ),
    );
    wrap(<ExportButton project="helsinki" target={{}} label={en.organization.projects.export} />);

    const trigger = screen.getByRole("button", { name: en.organization.projects.export });
    trigger.focus();
    await userEvent.keyboard("{Enter}");

    const dialog = await screen.findByRole("dialog");
    // The shared Dialog, which is what carries the focus trap and the escape key: a hand-built
    // Radix dialog had none of it (T-1816).
    expect(within(dialog).getAllByRole("radio")).toHaveLength(3);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("renders_no_trigger_when_the_row_menu_owns_it_and_still_opens_on_the_rows_word", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ apiVersion: "joinedcontext.com/v1alpha1", kind: "List", items: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      ),
    );
    const { rerender } = wrap(
      <ExportButton project="helsinki" target={{}} label={en.organization.projects.export} trigger={false} open={false} />,
    );
    expect(screen.queryByRole("button", { name: en.organization.projects.export })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();

    rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <I18nextProvider i18n={i18n}>
          <ExportButton project="helsinki" target={{}} label={en.organization.projects.export} trigger={false} open />
        </I18nextProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });
});
