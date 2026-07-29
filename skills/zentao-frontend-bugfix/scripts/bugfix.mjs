#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import {
  ensureZentaoToken,
  setupZentaoCredentials,
  withAutomaticTokenRefresh,
} from "./lib/auth.mjs";
import { loadConfig } from "./lib/config.mjs";
import { inspectConfig } from "./lib/doctor.mjs";
import { writeTriageReport } from "./lib/report.mjs";
import { triageBugs } from "./lib/triage.mjs";
import { selectCurrentWorkspace } from "./lib/workspace.mjs";

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) throw new Error(`无法识别的参数：${token}`);
    const key = token.slice(2);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) {
      options[key] = true;
    } else {
      options[key] = value;
      index += 1;
    }
  }
  return { command, options };
}

function requireOption(options, name) {
  if (!options[name]) throw new Error(`缺少参数：--${name}`);
  return path.resolve(options[name]);
}

function printHelp() {
  console.log(`禅道前端 Bug 分诊与修复

用法：
  bugfix.mjs triage --config /absolute/path/config.json
  bugfix.mjs start [--config /absolute/path/config.json]
  bugfix.mjs setup [--config /absolute/path/config.json]
  bugfix.mjs doctor --config /absolute/path/config.json
  bugfix.mjs workspace --config /absolute/path/config.json --report /absolute/path/triage.json --bug BUG_ID --confirmed
`);
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  if (!command || command === "help" || command === "--help") {
    printHelp();
    return;
  }

  async function collectTriage(config) {
    const items = await triageBugs(config);
    const { report, jsonPath, markdownPath } = await writeTriageReport(config, items);
    return {
      ok: true,
      report: jsonPath,
      summary: markdownPath,
      stats: report.stats,
    };
  }

  if (command === "triage") {
    const config = await loadConfig(requireOption(options, "config"));
    console.log(JSON.stringify(await collectTriage(config), null, 2));
    return;
  }

  const defaultConfigPath = options.config
    ? path.resolve(options.config)
    : path.resolve(".bugfix.local.json");

  if (command === "setup" || command === "auth") {
    const config = await loadConfig(defaultConfigPath);
    const result = await setupZentaoCredentials(config);
    console.log(
      JSON.stringify(
        {
          ok: true,
          credentialStore: result.credentialStore,
          accountFile: result.accountFile,
          tokenFile: result.tokenFile,
          message: "初始化完成；密码仅保存在 macOS 钥匙串中。",
        },
        null,
        2,
      ),
    );
    return;
  }

  if (command === "start") {
    const config = await loadConfig(defaultConfigPath);
    const token = await ensureZentaoToken(config);
    const triage = await withAutomaticTokenRefresh(config, () => collectTriage(config));
    console.log(
      JSON.stringify(
        {
          ...triage.value,
          tokenSource: token.source,
          tokenSavedOnThisRun: token.created,
          tokenAutoRefreshed: token.refreshed || triage.tokenAutoRefreshed,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (command === "doctor") {
    const config = await loadConfig(requireOption(options, "config"));
    const result = await inspectConfig(config);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 2;
    return;
  }

  if (command === "workspace") {
    const config = await loadConfig(requireOption(options, "config"));
    const reportPath = requireOption(options, "report");
    if (!options.bug) throw new Error("缺少参数：--bug");
    const result = await selectCurrentWorkspace(config, reportPath, options.bug, {
      confirmed: options.confirmed === true,
    });
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    return;
  }

  if (command === "prepare") {
    throw new Error("prepare 命令已移除：本流程不再创建 Git worktree；请在用户回复“确认修改”后使用 workspace --confirmed");
  }

  throw new Error(`未知命令：${command}`);
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
});
