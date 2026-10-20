import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { detectAgents, executableOnPath } from "../../src/cli/detect-agents";

describe("installed harness detection", () => {
  test("a config directory or a binary on PATH counts; nothing else does", async () => {
    const dirs = new Set([join("/h", ".claude"), join("/h", ".config", "opencode")]);
    const bins = new Set(["pi"]);
    const found = await detectAgents({ home: "/h", exists: async (p) => dirs.has(p), onPath: async (b) => bins.has(b) });
    expect(found).toEqual(["claude-code", "opencode", "pi"]);
    expect(await detectAgents({ home: "/h", exists: async () => false, onPath: async () => false })).toEqual([]);
  });
  test("Cursor counts by ~/.cursor or either of its binaries", async () => {
    const none = async () => false;
    expect(await detectAgents({ home: "/h", exists: async (p) => p === join("/h", ".cursor"), onPath: none })).toEqual(["cursor"]);
    expect(await detectAgents({ home: "/h", exists: none, onPath: async (b) => b === "cursor-agent" })).toEqual(["cursor"]);
    expect(await detectAgents({ home: "/h", exists: none, onPath: async (b) => b === "cursor" })).toEqual(["cursor"]);
  });
  test("executableOnPath scans PATH entries", async () => {
    const { basename, dirname } = await import("node:path");
    expect(await executableOnPath(basename(process.execPath), dirname(process.execPath))).toBe(true);
    expect(await executableOnPath("definitely-not-a-binary-xyz", dirname(process.execPath))).toBe(false);
  });
});
