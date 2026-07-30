import { constants as fileConstants } from "node:fs";
import {
  access,
  chmod,
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDirectory, "..");

async function exists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function assertDistributionSource(sourceRoot) {
  const requiredFiles = [
    path.join(sourceRoot, ".agents", "plugins", "marketplace.json"),
    path.join(
      sourceRoot,
      "plugins",
      "one-click-repair",
      ".codex-plugin",
      "plugin.json",
    ),
    path.join(
      sourceRoot,
      "plugins",
      "one-click-repair",
      "dist",
      "mcp-server.mjs",
    ),
  ];
  for (const requiredFile of requiredFiles) {
    try {
      await access(requiredFile, fileConstants.R_OK);
    } catch {
      throw new Error(`npm 包缺少 Plugin 发布文件：${requiredFile}`);
    }
  }
}

async function readPackageMetadata(sourceRoot) {
  const raw = JSON.parse(
    await readFile(path.join(sourceRoot, "package.json"), "utf8"),
  );
  return {
    packageName: raw.name,
    packageVersion: raw.version,
  };
}

export function resolveStableMarketplaceRoot(options = {}) {
  const homeDirectory = options.homeDirectory || os.homedir();
  const environment = options.environment || process.env;
  const codexHome = options.codexHome
    ? path.resolve(options.codexHome)
    : environment.CODEX_HOME
      ? path.resolve(environment.CODEX_HOME)
      : path.join(homeDirectory, ".codex");
  return path.join(codexHome, "one-click-repair", "marketplace");
}

export async function installBundledMarketplace(options = {}) {
  const sourceRoot = path.resolve(options.sourceRoot || packageRoot);
  const marketplaceRoot = resolveStableMarketplaceRoot(options);
  const installBase = path.dirname(marketplaceRoot);
  const nonce = `${process.pid}-${Date.now()}`;
  const stagingRoot = path.join(installBase, `.marketplace-staging-${nonce}`);
  const backupRoot = path.join(installBase, `.marketplace-backup-${nonce}`);

  await assertDistributionSource(sourceRoot);
  const packageMetadata = await readPackageMetadata(sourceRoot);
  await mkdir(installBase, { recursive: true, mode: 0o700 });
  await chmod(installBase, 0o700);
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true });
  await cp(
    path.join(sourceRoot, ".agents"),
    path.join(stagingRoot, ".agents"),
    { recursive: true },
  );
  await cp(
    path.join(sourceRoot, "plugins"),
    path.join(stagingRoot, "plugins"),
    { recursive: true },
  );
  await writeFile(
    path.join(stagingRoot, ".distribution.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        ...packageMetadata,
        installedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const replacedExisting = await exists(marketplaceRoot);
  if (replacedExisting) {
    await rename(marketplaceRoot, backupRoot);
  }

  try {
    await rename(stagingRoot, marketplaceRoot);
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    if (replacedExisting && !(await exists(marketplaceRoot))) {
      await rename(backupRoot, marketplaceRoot);
    }
    throw new Error(`无法安装稳定 Plugin 文件：${error.message}`, {
      cause: error,
    });
  }

  let retainedBackup;
  if (replacedExisting) {
    try {
      await rm(backupRoot, { recursive: true, force: true });
    } catch {
      retainedBackup = backupRoot;
    }
  }

  return {
    ...packageMetadata,
    sourceRoot,
    marketplaceRoot,
    replacedExisting,
    retainedBackup,
  };
}
