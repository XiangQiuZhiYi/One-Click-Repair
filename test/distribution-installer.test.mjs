import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  installBundledMarketplace,
  resolveStableMarketplaceRoot,
} from "../scripts/distribution-installer.mjs";

async function createPackageSource(root, version = "1.2.3") {
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
      plugins: [
        {
          name: "one-click-repair",
          source: {
            source: "local",
            path: "./plugins/one-click-repair",
          },
        },
      ],
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

test("npm 安装器将 Plugin 原子复制到稳定的 Codex 用户目录", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "one-click-repair-distribution-"),
  );
  const sourceRoot = path.join(directory, "package");
  const codexHome = path.join(directory, ".codex");
  try {
    await createPackageSource(sourceRoot);
    const first = await installBundledMarketplace({
      sourceRoot,
      codexHome,
    });
    const expectedRoot = path.join(
      codexHome,
      "one-click-repair",
      "marketplace",
    );
    assert.equal(first.marketplaceRoot, expectedRoot);
    assert.equal(first.replacedExisting, false);
    assert.equal(
      resolveStableMarketplaceRoot({ codexHome }),
      expectedRoot,
    );
    const metadata = JSON.parse(
      await readFile(path.join(expectedRoot, ".distribution.json"), "utf8"),
    );
    assert.equal(metadata.packageVersion, "1.2.3");
    await access(
      path.join(
        expectedRoot,
        "plugins",
        "one-click-repair",
        "dist",
        "mcp-server.mjs",
      ),
    );

    const staleFile = path.join(expectedRoot, "stale.txt");
    await writeFile(staleFile, "stale\n");
    const second = await installBundledMarketplace({
      sourceRoot,
      codexHome,
    });
    assert.equal(second.replacedExisting, true);
    await assert.rejects(access(staleFile));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
