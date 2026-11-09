/**
 * T-6694: the Endpoints header's search is said in words where the rows start; the query line
 * under the rows keeps the copyable q (`search~="(?i)noise"`).
 */
import { render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it } from "vitest";
import i18n from "../src/i18n";
import { SearchLine } from "../src/pages/endpoints/EndpointsGrid";

describe("SearchLine", () => {
  it("says what the search asks, as typed, and nothing without a search", async () => {
    await i18n.changeLanguage("en");
    const { rerender } = render(
      <I18nextProvider i18n={i18n}>
        <SearchLine text="  NOISE " />
      </I18nextProvider>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Endpoints whose name or title contains “NOISE”, in any case.");
    rerender(
      <I18nextProvider i18n={i18n}>
        <SearchLine text="   " />
      </I18nextProvider>,
    );
    expect(screen.queryByRole("status")).toBeNull();
  });
});
