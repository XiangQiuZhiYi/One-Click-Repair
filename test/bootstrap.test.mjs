import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  bootstrap,
  installSkill,
  writeUserConfig,
} from "../scripts/bootstrap.mjs";

const sourceSkillPath = path.resolve("skills/zentao-frontend-bugfix");

test("安装器将 Skill 复制到独立 CODEX_HOME", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bugfix-install-"));
  try {
    const result = await installSkill({
      codexHome: directory,
      sourceSkillPath,
      backupSuffix: "test",
    });
    const skill = await readFile(path.join(result.targetPath, "SKILL.md"), "utf8");
    assert.match(skill, /name: zentao-frontend-bugfix/);
    assert.equal(result.backupPath, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("更新 Skill 时将旧版本备份到非 Skill 扫描目录", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bugfix-update-"));
  try {
    await installSkill({
      codexHome: directory,
      sourceSkillPath,
      backupSuffix: "first",
    });
    const updated = await installSkill({
      codexHome: directory,
      sourceSkillPath,
      backupSuffix: "second",
    });
    assert.equal(
      updated.backupPath,
      path.join(directory, "skill-backups", "zentao-frontend-bugfix-second"),
    );
    assert.match(await readFile(path.join(updated.backupPath, "SKILL.md"), "utf8"), /name:/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("用户配置保存在 Codex 目录并保留已有执行仓库映射", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bugfix-config-"));
  try {
    const first = await writeUserConfig({
      codexHome: directory,
      baseUrl: "https://zentao.example.com/zentao/",
    });
    const initial = JSON.parse(await readFile(first.configPath, "utf8"));
    initial.repositoriesByExecution["2640"] = "/workspace/sisreact";
    await writeFile(first.configPath, `${JSON.stringify(initial, null, 2)}\n`);

    const second = await writeUserConfig({
      codexHome: directory,
      baseUrl: "https://zentao.example.com/zentao",
    });
    const config = JSON.parse(await readFile(second.configPath, "utf8"));
    assert.equal(config.source.baseUrl, "https://zentao.example.com/zentao");
    assert.equal(config.repositoriesByExecution["2640"], "/workspace/sisreact");
    assert.equal((await stat(second.configPath)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("一键初始化串联 Skill 安装、配置生成和凭据初始化", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bugfix-bootstrap-"));
  let observedConfig;
  try {
    const result = await bootstrap({
      platform: "darwin",
      codexHome: directory,
      sourceSkillPath,
      baseUrl: "https://zentao.example.com/zentao",
      backupSuffix: "test",
      setupCredentials: async (config) => {
        observedConfig = config;
        return { credentialStore: "test" };
      },
    });
    assert.equal(observedConfig.source.type, "zentao-v1");
    assert.equal(observedConfig.source.baseUrl, "https://zentao.example.com/zentao");
    assert.equal(result.configPath, path.join(directory, "zentao-frontend-bugfix", "config.json"));
    assert.equal(
      result.skillPath,
      path.join(directory, "skills", "zentao-frontend-bugfix"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
