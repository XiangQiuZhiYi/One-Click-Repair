import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  installLocalPlugin,
  PLUGIN_SPEC,
  resolveCodexCommand,
} from "../scripts/plugin-manager.mjs";

test("终端 PATH 中没有 codex 时自动发现 Codex Desktop 内置 CLI", async () => {
  const bundledCli = "/Applications/ChatGPT.app/Contents/Resources/codex";
  const attempted = [];
  const result = await resolveCodexCommand({
    environment: { PATH: "" },
    homeDirectory: "/Users/new-user",
    platform: "darwin",
    accessFile: async (candidate) => {
      attempted.push(candidate);
      if (candidate !== bundledCli) {
        const error = new Error("not found");
        error.code = "ENOENT";
        throw error;
      }
    },
  });

  assert.equal(result, bundledCli);
  assert.ok(attempted.includes("/Applications/Codex.app/Contents/Resources/codex"));
  assert.ok(attempted.includes(bundledCli));
});

test("只安装 VS Code Codex 扩展时自动发现扩展内置 CLI", async () => {
  const homeDirectory = await mkdtemp(
    path.join(os.tmpdir(), "one-click-repair-vscode-"),
  );
  const bundledCli = path.join(
    homeDirectory,
    ".vscode",
    "extensions",
    "openai.chatgpt-26.721.41059-darwin-arm64",
    "bin",
    "macos-aarch64",
    "codex",
  );
  try {
    await mkdir(path.dirname(bundledCli), { recursive: true });
    await writeFile(bundledCli, "#!/bin/sh\n");
    await chmod(bundledCli, 0o755);

    const result = await resolveCodexCommand({
      environment: { PATH: "" },
      homeDirectory,
      platform: "darwin",
      extensionRoots: [path.join(homeDirectory, ".vscode", "extensions")],
    });

    assert.equal(result, bundledCli);
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("支持通过 CODEX_CLI_PATH 指定自定义 Codex CLI", async () => {
  const customCli = "/opt/codex/bin/codex";
  const result = await resolveCodexCommand({
    environment: { PATH: "", CODEX_CLI_PATH: customCli },
    platform: "darwin",
    accessFile: async (candidate) => {
      assert.equal(candidate, customCli);
    },
  });

  assert.equal(result, customCli);
});

test("确实没有 Codex CLI 时返回可操作的错误说明", async () => {
  await assert.rejects(
    resolveCodexCommand({
      environment: { PATH: "" },
      homeDirectory: "/Users/new-user",
      platform: "darwin",
      accessFile: async () => {
        throw new Error("not found");
      },
    }),
    /CODEX_CLI_PATH/,
  );
});

test("首次安装时先添加本地 Marketplace 再安装 Plugin", async () => {
  const calls = [];
  const repositoryRoot = "/workspace/One-Click-Repair";
  const result = await installLocalPlugin({
    repositoryRoot,
    execute: async (args) => {
      calls.push(args);
      return { stdout: "MARKETPLACE ROOT\nopenai-bundled /tmp/bundled" };
    },
  });

  assert.deepEqual(calls, [
    ["plugin", "marketplace", "list"],
    ["plugin", "marketplace", "add", repositoryRoot],
    ["plugin", "add", PLUGIN_SPEC],
  ]);
  assert.equal(result.marketplaceAdded, true);
});

test("Marketplace 已存在时直接安装或更新 Plugin", async () => {
  const calls = [];
  const repositoryRoot = "/workspace/One-Click-Repair";
  const result = await installLocalPlugin({
    repositoryRoot,
    execute: async (args) => {
      calls.push(args);
      return {
        stdout: `MARKETPLACE ROOT\none-click-repair ${repositoryRoot}`,
      };
    },
  });

  assert.deepEqual(calls, [
    ["plugin", "marketplace", "list"],
    ["plugin", "add", PLUGIN_SPEC],
  ]);
  assert.equal(result.marketplaceAdded, false);
});
