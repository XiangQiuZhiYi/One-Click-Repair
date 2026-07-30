import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  bootstrap,
  retireLegacySkill,
  writeUserConfig,
} from "../scripts/bootstrap.mjs";

test("没有旧版独立 Skill 时无需迁移", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bugfix-install-"));
  try {
    const result = await retireLegacySkill({
      codexHome: directory,
      backupSuffix: "test",
    });
    assert.equal(result.retired, false);
    assert.equal(result.backupPath, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("升级 Plugin 时将旧版独立 Skill 移到备份目录", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bugfix-update-"));
  try {
    const legacyPath = path.join(directory, "skills", "zentao-frontend-bugfix");
    await mkdir(legacyPath, { recursive: true });
    await writeFile(path.join(legacyPath, "SKILL.md"), "---\nname: legacy\n---\n");

    const updated = await retireLegacySkill({
      codexHome: directory,
      backupSuffix: "second",
    });
    assert.equal(updated.retired, true);
    assert.equal(
      updated.backupPath,
      path.join(directory, "skill-backups", "zentao-frontend-bugfix-second"),
    );
    assert.match(await readFile(path.join(updated.backupPath, "SKILL.md"), "utf8"), /name:/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("用户配置保存在 Codex 目录并保留已有项目仓库映射", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bugfix-config-"));
  try {
    const first = await writeUserConfig({
      codexHome: directory,
      baseUrl: "https://zentao.example.com/zentao/",
    });
    const initial = JSON.parse(await readFile(first.configPath, "utf8"));
    initial.repositoriesByProject.sisreact = "/workspace/sisreact";
    await writeFile(first.configPath, `${JSON.stringify(initial, null, 2)}\n`);

    const second = await writeUserConfig({
      codexHome: directory,
      baseUrl: "https://zentao.example.com/zentao",
    });
    const config = JSON.parse(await readFile(second.configPath, "utf8"));
    assert.equal(config.source.baseUrl, "https://zentao.example.com/zentao");
    assert.equal(config.repositoriesByProject.sisreact, "/workspace/sisreact");
    assert.equal((await stat(second.configPath)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("一键初始化串联 Plugin 安装、配置生成和凭据初始化", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bugfix-bootstrap-"));
  let observedConfig;
  let pluginInstallOptions;
  const events = [];
  try {
    const result = await bootstrap({
      platform: "darwin",
      codexHome: directory,
      baseUrl: "https://zentao.example.com/zentao",
      backupSuffix: "test",
      repositoryRoot: "/workspace/One-Click-Repair",
      setupCredentials: async (config) => {
        events.push("credentials");
        observedConfig = config;
        return { credentialStore: "test" };
      },
      installPlugin: async (options) => {
        events.push("plugin");
        pluginInstallOptions = options;
        return {
          pluginName: "one-click-repair",
          marketplaceName: "one-click-repair",
        };
      },
    });
    assert.equal(observedConfig.source.type, "zentao-v1");
    assert.equal(observedConfig.source.baseUrl, "https://zentao.example.com/zentao");
    assert.equal(result.configPath, path.join(directory, "zentao-frontend-bugfix", "config.json"));
    assert.equal(result.plugin.pluginName, "one-click-repair");
    assert.equal(pluginInstallOptions.repositoryRoot, "/workspace/One-Click-Repair");
    assert.deepEqual(events, ["plugin", "credentials"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
