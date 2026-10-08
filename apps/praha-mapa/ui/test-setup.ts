import "@testing-library/jest-dom/vitest";
import { afterAll } from "vitest";
import { recordControls } from "@joinedcontext/sdk/testing";

// Every control a test file renders and which its tests use, for the Apps' coverage gate (T-3373).
recordControls(afterAll);
