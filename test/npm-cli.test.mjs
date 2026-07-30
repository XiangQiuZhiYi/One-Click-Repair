import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  isMainModule,
  parseCliArguments,
  runSetup,
  runUpdate,
} from "../scripts/npm-cli.mjs";

async function createPackageSource(root, version = "0.6.0") {
  const marketplaceFile = path.join(
    root,
    ".agents",
    "plugins",
    "marketplace.json",
  );
  const pluginRoot = path.join(root, "plugins", "one-click-repair");
  await mkdir(path.dirname(marketplaceFile), { recursive: true });
  await mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
  await mkdir(path.join(pluginRoot, "dist"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "one-click-repair", version }),
  );
  await writeFile(
    marketplaceFile,
    JSON.stringify({
      name: "one-click-repair",
      plugins: [],
    }),
  );
  await writeFile(
    path.join(pluginRoot, ".codex-plugin", "plugin.json"),
    JSON.stringify({ name: "one-click-repair", version }),
  );
  await writeFile(
    path.join(pluginRoot, "dist", "mcp-server.mjs"),
    "console.error('mcp');\n",
  );
}

test("npm CLI 解析 setup 和禅道地址", () => {
  assert.deepEqual(
    parseCliArguments([
      "setup",
      "--base-url",
      "https://zentao.example.com/zentao",
    ]),
    {
      command: "setup",
      options: { baseUrl: "https://zentao.example.com/zentao" },
    },
  );
});

test("npm bin 符号链接可以识别为 CLI 主入口", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "one-click-repair-bin-link-"),
  );
  const linkPath = path.join(directory, "one-click-repair");
  const cliPath = path.resolve("scripts/npm-cli.mjs");
  try {
    await symlink(cliPath, linkPath);
    assert.equal(isMainModule(linkPath), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("npm setup 安装稳定 Plugin 后完成初始化", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "one-click-repair-npm-setup-"),
  );
  const sourceRoot = path.join(directory, "package");
  const codexHome = path.join(directory, ".codex");
  let installedRoot;
  try {
    await createPackageSource(sourceRoot);
    const result = await runSetup({
      sourceRoot,
      codexHome,
      platform: "darwin",
      baseUrl: "https://zentao.example.com/zentao",
      installPlugin: async ({ repositoryRoot }) => {
        installedRoot = repositoryRoot;
        return { pluginName: "one-click-repair" };
      },
      setupCredentials: async () => ({ credentialStore: "test" }),
    });

    assert.equal(result.ok, true);
    assert.equal(installedRoot, result.distribution.marketplaceRoot);
    assert.equal(
      result.distribution.marketplaceRoot,
      path.join(codexHome, "one-click-repair", "marketplace"),
    );
    const config = JSON.parse(await readFile(result.configPath, "utf8"));
    assert.equal(
      config.source.baseUrl,
      "https://zentao.example.com/zentao",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("npm update 只替换 Plugin 分发文件，不初始化禅道凭据", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "one-click-repair-npm-update-"),
  );
  const sourceRoot = path.join(directory, "package");
  const codexHome = path.join(directory, ".codex");
  let installedRoot;
  try {
    await createPackageSource(sourceRoot);
    const result = await runUpdate({
      sourceRoot,
      codexHome,
      installPlugin: async ({ repositoryRoot }) => {
        installedRoot = repositoryRoot;
        return { pluginName: "one-click-repair" };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.command, "update");
    assert.equal(installedRoot, result.distribution.marketplaceRoot);
    assert.match(result.message, /凭据未修改/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
