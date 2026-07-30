#!/usr/bin/env node

import { realpathSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { bootstrap, resolveCodexHome, retireLegacySkill } from "./bootstrap.mjs";
import { installBundledMarketplace } from "./distribution-installer.mjs";
import { installLocalPlugin } from "./plugin-manager.mjs";
import { findDefaultConfigPath } from "../plugins/one-click-repair/skills/zentao-frontend-bugfix/scripts/lib/config-path.mjs";
import { loadConfig } from "../plugins/one-click-repair/skills/zentao-frontend-bugfix/scripts/lib/config.mjs";
import { inspectConfig } from "../plugins/one-click-repair/skills/zentao-frontend-bugfix/scripts/lib/doctor.mjs";

function printHelp() {
  console.log(`One-Click-Repair npm 一键安装器

用法：
  one-click-repair setup [--base-url https://zentao.example.com/zentao]
  one-click-repair update
  one-click-repair doctor

命令：
  setup   安装或更新 Codex Plugin，并初始化禅道地址、账号和密码
  update  更新稳定目录中的 Plugin，不修改禅道配置和凭据
  doctor  检查配置、认证文件和仓库映射，不访问禅道
`);
}

export function parseCliArguments(argv) {
  const [command = "help", ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--base-url") {
      const value = rest[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--base-url 缺少值");
      }
      options.baseUrl = value;
      index += 1;
    } else {
      throw new Error(`无法识别的参数：${token}`);
    }
  }
  return { command, options };
}

export async function runSetup(options = {}) {
  const codexHome = options.codexHome || resolveCodexHome();
  const distribution = await installBundledMarketplace({
    codexHome,
    sourceRoot: options.sourceRoot,
  });
  const result = await bootstrap({
    codexHome,
    baseUrl: options.baseUrl,
    repositoryRoot: distribution.marketplaceRoot,
    platform: options.platform,
    readValue: options.readValue,
    setupCredentials: options.setupCredentials,
    installPlugin: options.installPlugin,
    backupSuffix: options.backupSuffix,
  });
  return {
    ok: true,
    command: "setup",
    distribution,
    plugin: result.plugin,
    configPath: result.configPath,
    previousSkillBackup: result.previousSkillBackup,
    message:
      "安装和初始化已完成。请完全退出并重新打开 Codex，然后在新任务中输入“执行一键禅道”。",
  };
}

export async function runUpdate(options = {}) {
  const codexHome = options.codexHome || resolveCodexHome();
  const distribution = await installBundledMarketplace({
    codexHome,
    sourceRoot: options.sourceRoot,
  });
  const installPlugin = options.installPlugin || installLocalPlugin;
  const plugin = await installPlugin({
    repositoryRoot: distribution.marketplaceRoot,
  });
  const legacy = await retireLegacySkill({
    codexHome,
    backupSuffix: options.backupSuffix,
  });
  return {
    ok: true,
    command: "update",
    distribution,
    plugin,
    previousSkillBackup: legacy.backupPath,
    message:
      "Plugin 已更新，禅道配置和凭据未修改。请完全退出并重新打开 Codex。",
  };
}

export async function runDoctor(options = {}) {
  const configPath = await findDefaultConfigPath(
    options.configPath ? { config: options.configPath } : {},
  );
  const config = await loadConfig(configPath);
  return {
    command: "doctor",
    ...(await inspectConfig(config)),
  };
}

export async function runCli(argv, options = {}) {
  const parsed = parseCliArguments(argv);
  if (["help", "--help", "-h"].includes(parsed.command)) {
    printHelp();
    return { ok: true, command: "help" };
  }
  if (parsed.command === "setup") {
    return runSetup({ ...options, ...parsed.options });
  }
  if (parsed.command === "update") {
    if (parsed.options.baseUrl) {
      throw new Error("update 不接受 --base-url；修改禅道地址请重新运行 setup");
    }
    return runUpdate(options);
  }
  if (parsed.command === "doctor") {
    if (parsed.options.baseUrl) {
      throw new Error("doctor 不接受 --base-url");
    }
    return runDoctor(options);
  }
  throw new Error(`未知命令：${parsed.command}`);
}

export function isMainModule(
  executablePath = process.argv[1],
  moduleUrl = import.meta.url,
) {
  if (!executablePath) return false;
  try {
    return realpathSync(executablePath) === fileURLToPath(moduleUrl);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  runCli(process.argv.slice(2))
    .then((result) => {
      if (result.command !== "help") {
        console.log(JSON.stringify(result, null, 2));
      }
      if (result.command === "doctor" && !result.ok) {
        process.exitCode = 2;
      }
    })
    .catch((error) => {
      console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
      process.exitCode = 1;
    });
}
