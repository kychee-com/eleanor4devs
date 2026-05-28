/**
 * Tests for the path constants exported from `packages/cli/src/cli.ts`.
 *
 * Spec: docs/products/eleanor4devs/eleanor4devs-spec.md § Local Reporting
 *   Control. Plan: Phase 19, Group A — `STATE_PATH` constant.
 *
 * Every CLI command must resolve the reporting-state file to the same
 * canonical path (`~/.eleanor4devs/state.json`); this test pins that
 * contract.
 */
import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";

import { STATE_PATH } from "../src/cli.js";

describe("STATE_PATH — canonical reporting-state path", () => {
  it("resolves to ~/.eleanor4devs/state.json", () => {
    expect(STATE_PATH).toBe(join(homedir(), ".eleanor4devs", "state.json"));
  });
});
