import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function findDefaultConfigPath(options = {}) {
  if (options.config) return path.resolve(options.config);
  const environment = options.environment || process.env;
  const codexHome = environment.CODEX_HOME
    ? path.resolve(environment.CODEX_HOME)
    : path.join(options.homeDirectory || os.homedir(), ".codex");
  const currentDirectory = options.currentDirectory || process.cwd();
  const candidates = [
    environment.ZENTAO_BUGFIX_CONFIG,
    path.join(currentDirectory, ".bugfix.local.json"),
    path.join(codexHome, "zentao-frontend-bugfix", "config.json"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const absolutePath = path.resolve(candidate);
    if (await fileExists(absolutePath)) return absolutePath;
  }
  throw new Error(
    "找不到禅道配置。请运行 npx one-click-repair@latest setup（源码安装可运行 npm run bootstrap）",
  );
}
