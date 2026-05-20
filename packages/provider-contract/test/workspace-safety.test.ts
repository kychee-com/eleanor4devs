import { describe, it, expect } from "vitest";
import {
  validateWorkspaceSafety,
  WorkspaceSafetyError,
} from "../src/index.js";

const ok = {
  cwd: "/home/user/repos/myproj",
  workspace_path: "/home/user/repos/myproj",
  workspace_root: "/home/user/repos",
  identifier: "myproj-build-42",
};

describe("validateWorkspaceSafety (spec § Provider Boxes, Symphony pattern #3)", () => {
  it("returns ok on a well-formed input", () => {
    expect(() => validateWorkspaceSafety(ok)).not.toThrow();
  });

  it("rejects cwd that differs from workspace_path", () => {
    expect(() =>
      validateWorkspaceSafety({ ...ok, cwd: "/home/user/elsewhere" }),
    ).toThrow(WorkspaceSafetyError);
  });

  it("rejects workspace_path that is not prefix-contained by workspace_root", () => {
    expect(() =>
      validateWorkspaceSafety({
        ...ok,
        cwd: "/etc/passwd",
        workspace_path: "/etc/passwd",
      }),
    ).toThrow(WorkspaceSafetyError);
  });

  it("rejects workspace_path that escapes workspace_root via path traversal", () => {
    // `/home/user/repos/../../../etc` would resolve outside workspace_root.
    // Validator must normalize before comparing.
    expect(() =>
      validateWorkspaceSafety({
        ...ok,
        cwd: "/home/user/repos/../../../etc",
        workspace_path: "/home/user/repos/../../../etc",
      }),
    ).toThrow(WorkspaceSafetyError);
  });

  it("rejects identifier containing characters outside [A-Za-z0-9._-]", () => {
    expect(() =>
      validateWorkspaceSafety({ ...ok, identifier: "bad/identifier" }),
    ).toThrow(WorkspaceSafetyError);
    expect(() =>
      validateWorkspaceSafety({ ...ok, identifier: "has space" }),
    ).toThrow(WorkspaceSafetyError);
    expect(() =>
      validateWorkspaceSafety({ ...ok, identifier: "tab\there" }),
    ).toThrow(WorkspaceSafetyError);
    expect(() =>
      validateWorkspaceSafety({ ...ok, identifier: "" }),
    ).toThrow(WorkspaceSafetyError);
  });

  it("accepts identifiers that use the full allowed character set", () => {
    expect(() =>
      validateWorkspaceSafety({ ...ok, identifier: "AaZz09._-" }),
    ).not.toThrow();
  });

  it("WorkspaceSafetyError exposes which invariant failed", () => {
    try {
      validateWorkspaceSafety({ ...ok, identifier: "bad/identifier" });
      expect.fail("expected validateWorkspaceSafety to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceSafetyError);
      expect((err as WorkspaceSafetyError).invariant).toBe("identifier");
    }
  });
});
