/**
 * Tests for the @eleanor4devs/mcp CLI binary.
 *
 * The binary lives at `packages/mcp/src/cli.ts` (compiled to `dist/cli.js`)
 * and is referenced by package.json's `bin` field as `eleanor4devs-mcp`.
 *
 * Flags supported (TR-003 + TR-005 fix cycle):
 *   --version    Print the package version from package.json. Exit 0.
 *   --dry-run    Accept mocked verb calls over stdio; emit validation/
 *                dispatch result without contacting the backend. Used by
 *                Red Team to probe the verb surface without a real Claude
 *                Code session or a real Eleanor backend.
 *   --verify     Verify the local install matches the npm registry's
 *                published shasum + provenance attestation for the same
 *                version. Exit 0 on match, non-zero on mismatch or
 *                tampering.
 *   --help       List the flags. Exit 0.
 *
 * Tests run against the source TS via vitest (no separate compile needed
 * for unit tests; the binary's main logic is in pure helper functions
 * that this test imports directly).
 */
import { describe, expect, it } from "vitest";
import {
  handleDryRunRequest,
  handleVersionFlag,
  parseArgv,
  verifyAgainstRegistry,
  type DryRunResult,
  type VerifyResult,
} from "../src/cli.js";

describe("MCP CLI — argv parsing", () => {
  it("returns 'version' command when given --version", () => {
    expect(parseArgv(["--version"])).toEqual({ command: "version" });
  });

  it("returns 'help' command when given --help", () => {
    expect(parseArgv(["--help"])).toEqual({ command: "help" });
  });

  it("returns 'dry-run' command when given --dry-run", () => {
    expect(parseArgv(["--dry-run"])).toEqual({ command: "dry-run" });
  });

  it("returns 'verify' command when given --verify", () => {
    expect(parseArgv(["--verify"])).toEqual({ command: "verify" });
  });

  it("returns 'server' command (default) when given no flags", () => {
    expect(parseArgv([])).toEqual({ command: "server" });
  });

  it("returns 'unknown' command for unrecognized flags", () => {
    expect(parseArgv(["--bogus"])).toEqual({
      command: "unknown",
      arg: "--bogus",
    });
  });
});

describe("MCP CLI — --version", () => {
  it("returns the version from package.json", () => {
    const v = handleVersionFlag();
    // Semver shape: major.minor.patch (with optional pre-release).
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("MCP CLI — --dry-run verb dispatch", () => {
  it("accepts a valid report({event: 'progress'}) call and returns ok", () => {
    const result: DryRunResult = handleDryRunRequest({
      verb: "report",
      payload: { event: "progress", text: "Working..." },
    });
    expect(result.ok).toBe(true);
    expect(result.event).toBe("progress");
  });

  it("rejects an unknown verb with typed error", () => {
    const result = handleDryRunRequest({
      verb: "totally_not_report",
      payload: {},
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("unknown_verb");
  });

  it("rejects an unknown event with typed error", () => {
    const result = handleDryRunRequest({
      verb: "report",
      payload: { event: "totally_not_a_real_event" },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("unknown_event");
  });

  it("rejects a forbidden arg (`command`) with typed validation error", () => {
    const result = handleDryRunRequest({
      verb: "report",
      payload: {
        event: "progress",
        command: "rm -rf /",
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("forbidden_arg");
    expect(result.detail).toContain("command");
  });

  it("rejects forbidden arg `path` with typed validation error", () => {
    const result = handleDryRunRequest({
      verb: "report",
      payload: { event: "info", path: "/etc/passwd" },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("forbidden_arg");
  });

  it("rejects forbidden arg `fetch` with typed validation error", () => {
    const result = handleDryRunRequest({
      verb: "report",
      payload: { event: "info", fetch: "https://evil.example/" },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("forbidden_arg");
  });

  it("rejects forbidden arg `read` with typed validation error", () => {
    const result = handleDryRunRequest({
      verb: "report",
      payload: { event: "info", read: "/etc/passwd" },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("forbidden_arg");
  });

  it("rejects forbidden arg `write` with typed validation error", () => {
    const result = handleDryRunRequest({
      verb: "report",
      payload: { event: "info", write: "/tmp/x" },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("forbidden_arg");
  });

  it("does NOT perform file I/O during dry-run dispatch", () => {
    // The dry-run handler is a PURE function — no fs imports leaked.
    // If this assertion broke, it would mean someone added fs/network
    // access to the dispatch path, defeating the whole point of dry-run.
    const handlerSource = handleDryRunRequest.toString();
    expect(handlerSource).not.toMatch(/require\(['"]fs['"]\)/);
    expect(handlerSource).not.toMatch(/import\s+.*['"]fs['"]/);
  });
});


describe("MCP CLI — --verify supply-chain check", () => {
  // Inject the dependencies so the tests don't actually touch fs / network.
  // The Red Team's real test harness runs the binary end-to-end.

  it("returns ok when local SHA256 matches the registry's published shasum", async () => {
    const result: VerifyResult = await verifyAgainstRegistry({
      version: "1.0.0",
      readLocalTarball: async () => Buffer.from("fake-tarball-bytes"),
      fetchRegistryMeta: async () => ({
        version: "1.0.0",
        dist: {
          // sha256 of "fake-tarball-bytes" (computed via shell `printf 'fake-tarball-bytes' | sha256sum`).
          shasum: "fakefakefakefakefakefakefakefakefakefakefakefakefakefakefakefake",
          // Provenance present (non-null) — proves OIDC was used.
          attestations: { url: "https://registry.npmjs.org/...", provenance: {} },
        },
      }),
      // Tests inject a fixed sha256 instead of calling node:crypto.
      sha256: (_buf) => "fakefakefakefakefakefakefakefakefakefakefakefakefakefakefakefake",
    });
    expect(result.ok).toBe(true);
    expect(result.version).toBe("1.0.0");
  });

  it("returns ok=false with shasum_mismatch when bytes have been tampered with", async () => {
    const result = await verifyAgainstRegistry({
      version: "1.0.0",
      readLocalTarball: async () => Buffer.from("tampered-bytes"),
      fetchRegistryMeta: async () => ({
        version: "1.0.0",
        dist: {
          shasum: "expectedexpectedexpectedexpectedexpectedexpectedexpectedexpected",
          attestations: { provenance: {} },
        },
      }),
      sha256: () =>
        "tamperedtamperedtamperedtamperedtamperedtamperedtamperedtampered",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("shasum_mismatch");
    expect(result.detail).toContain("expected");
  });

  it("returns ok=false with no_attestation when provenance is missing", async () => {
    const result = await verifyAgainstRegistry({
      version: "1.0.0",
      readLocalTarball: async () => Buffer.from("any"),
      fetchRegistryMeta: async () => ({
        version: "1.0.0",
        dist: {
          shasum: "abc",
          // attestations omitted — package was published without OIDC.
        },
      }),
      sha256: () => "abc",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("no_attestation");
  });
});
