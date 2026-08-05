#!/usr/bin/env node

import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  readVisibleValue,
  setupZentaoCredentials,
} from "../plugins/one-click-repair/skills/zentao-frontend-bugfix/scripts/lib/auth.mjs";
import { loadConfig } from "../plugins/one-click-repair/skills/zentao-frontend-bugfix/scripts/lib/config.mjs";
import { installLocalPlugin } from "./plugin-manager.mjs";

async function exists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

export function resolveCodexHome(environment = process.env, homeDirectory = os.homedir()) {
  return environment.CODEX_HOME
    ? path.resolve(environment.CODEX_HOME)
    : path.join(homeDirectory, ".codex");
}

export async function retireLegacySkill(options = {}) {
  const codexHome = options.codexHome || resolveCodexHome();
  const targetPath = path.join(codexHome, "skills", "zentao-frontend-bugfix");
  const backupDirectory = path.join(codexHome, "skill-backups");
  const backupPath = path.join(
    backupDirectory,
    `zentao-frontend-bugfix-${options.backupSuffix || Date.now()}`,
  );

  if (!(await exists(targetPath))) {
    return { retired: false, targetPath, backupPath: undefined };
  }
  await mkdir(backupDirectory, { recursive: true });
  await rename(targetPath, backupPath);
  return { retired: true, targetPath, backupPath };
}

function defaultConfig(baseUrl, existing = {}) {
  return {
    source: {
      personalBugListMode: "assigned-to-me",
      personalBugListPath: "my-work-bug-assignedTo--id_desc.html",
      personalBugPageSize: 100,
      maxPersonalBugPages: 20,
      productPageSize: 100,
      maxProductPages: 20,
      pageSize: 100,
      maxPagesPerProduct: 100,
      productConcurrency: 3,
      detailConcurrency: 4,
      requestTimeoutMs: 15000,
      requestRetries: 2,
      retryDelayMs: 300,
      ...(existing.source ?? {}),
      type: "zentao-v1",
      baseUrl,
      tokenFile: "./secrets/zentao-token",
      accountFile: "./secrets/zentao-account",
    },
    outputDir: existing.outputDir || "./output",
    repositoriesByProject: existing.repositoriesByProject ?? {},
    policy: {
      closedStatuses: ["closed", "已关闭"],
      autoFixCategories: [
        "STYLE",
        "COPY",
        "FORM_VALIDATION",
        "NULL_GUARD",
        "API_MAPPING",
        "BUILD",
      ],
      minAutoFixConfidence: 0.75,
      ...(existing.policy ?? {}),
    },
  };
}

async function readExistingConfig(configPath) {
  if (!(await exists(configPath))) return {};
  const text = await readFile(configPath, "utf8");
  return JSON.parse(text);
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/g, "");
}

export async function writeUserConfig(options = {}) {
  const codexHome = options.codexHome || resolveCodexHome();
  const configDirectory = path.join(codexHome, "zentao-frontend-bugfix");
  const configPath = path.join(configDirectory, "config.json");
  const existing = await readExistingConfig(configPath);
  let baseUrl = normalizeBaseUrl(options.baseUrl || existing.source?.baseUrl);

  if (!baseUrl) {
    const prompt = options.readValue || readVisibleValue;
    baseUrl = normalizeBaseUrl(
      await prompt("禅道地址（例如 https://zentao.example.com/zentao）："),
    );
  }
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new Error("禅道地址必须以 http:// 或 https:// 开头");
  }

  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  await chmod(configDirectory, 0o700);
  await writeFile(
    configPath,
    `${JSON.stringify(defaultConfig(baseUrl, existing), null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await chmod(configPath, 0o600);
  return { configPath, baseUrl };
}

export async function bootstrap(options = {}) {
  if ((options.platform || process.platform) !== "darwin") {
    throw new Error("当前初始化器依赖 macOS 钥匙串，仅支持 macOS");
  }
  const codexHome = options.codexHome || resolveCodexHome();
  const installPlugin = options.installPlugin || installLocalPlugin;
  const plugin = await installPlugin({
    repositoryRoot: options.repositoryRoot,
  });
  const configured = await writeUserConfig({
    codexHome,
    baseUrl: options.baseUrl,
    readValue: options.readValue,
  });
  const config = await loadConfig(configured.configPath);
  const setup = options.setupCredentials || setupZentaoCredentials;
  await setup(config);
  const legacy = await retireLegacySkill({
    codexHome,
    backupSuffix: options.backupSuffix,
  });
  return {
    codexHome,
    plugin,
    previousSkillBackup: legacy.backupPath,
    configPath: configured.configPath,
  };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--base-url") {
      const value = argv[index + 1];
      if (!value) throw new Error("--base-url 缺少值");
      options.baseUrl = value;
      index += 1;
    } else {
      throw new Error(`无法识别的参数：${token}`);
    }
  }
  return options;
}

async function main() {
  const result = await bootstrap(parseArguments(process.argv.slice(2)));
  console.log(
    JSON.stringify(
      {
        ok: true,
        plugin: result.plugin,
        configPath: result.configPath,
        message: "Plugin、禅道账号和本地配置均已初始化。请完全退出并重新打开 Codex，然后在聊天中输入“执行一键禅道”。",
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exitCode = 1;
  });
}
