import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { findDefaultConfigPath } from "../plugins/one-click-repair/skills/zentao-frontend-bugfix/scripts/lib/config-path.mjs";

test("执行器可以在任意目录发现 CODEX_HOME 中的用户配置", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bugfix-config-path-"));
  try {
    const codexHome = path.join(directory, "codex-home");
    const unrelatedCwd = path.join(directory, "other-project");
    const configPath = path.join(codexHome, "zentao-frontend-bugfix", "config.json");
    await mkdir(path.dirname(configPath), { recursive: true });
    await mkdir(unrelatedCwd);
    await writeFile(configPath, "{}\n");

    const result = await findDefaultConfigPath({
      environment: { CODEX_HOME: codexHome },
      currentDirectory: unrelatedCwd,
    });
    assert.equal(result, configPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
