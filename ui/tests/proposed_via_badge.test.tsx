import { render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { beforeEach, describe, expect, it } from "vitest";
import i18n from "../src/i18n";
import {
  ProposedViaBadge,
  ProposedViaHint,
} from "../src/components/ProposedViaBadge";

const CONNECTOR = {
  channel: "mcp",
  client: "claude-code",
  connector: "abcdefghijklmnopqrstuvwxyz",
  connectorName: "doprava-in-claude",
  plan: "p2345234523452345234523452",
};

function renderVia(children: React.ReactNode) {
  return render(
    <I18nextProvider i18n={i18n}>
      <dl>{children}</dl>
    </I18nextProvider>,
  );
}

// T-5973: the approver reads which connector and which plan a change came through.
describe("proposed-via badge", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("names the connector and the plan of a change a connector applied", () => {
    renderVia(
      <>
        <ProposedViaBadge via={CONNECTOR} />
        <ProposedViaHint via={CONNECTOR} author="Marek Mráz" />
      </>,
    );
    expect(screen.getByTestId("change-proposed-via")).toHaveTextContent(
      "Via claude-code connector doprava-in-claude",
    );
    expect(screen.getByTestId("change-proposed-plan")).toHaveTextContent(
      "Plan p2345234523452345234523452",
    );
  });

  it("names only the client of a change made over MCP without a connector", () => {
    const via = { channel: "mcp", client: "mcp-mobile" };
    renderVia(
      <>
        <ProposedViaBadge via={via} />
        <ProposedViaHint via={via} author="Marek Mráz" />
      </>,
    );
    expect(screen.getByTestId("change-proposed-via")).not.toHaveTextContent(
      "connector",
    );
    expect(screen.queryByTestId("change-proposed-plan")).toBeNull();
  });
});
