import { execFile } from "node:child_process";
import { constants as fileConstants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));

export const PLUGIN_NAME = "one-click-repair";
export const MARKETPLACE_NAME = "one-click-repair";
export const PLUGIN_SPEC = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;

export function resolveRepositoryRoot() {
  return path.resolve(scriptDirectory, "..");
}

async function resolveIdeExtensionCandidates(options = {}) {
  const homeDirectory = options.homeDirectory || os.homedir();
  const platform = options.platform || process.platform;
  const executableName = platform === "win32" ? "codex.exe" : "codex";
  const readDirectory = options.readDirectory || readdir;
  const extensionRoots = options.extensionRoots || [
    path.join(homeDirectory, ".vscode", "extensions"),
    path.join(homeDirectory, ".vscode-insiders", "extensions"),
    path.join(homeDirectory, ".cursor", "extensions"),
    path.join(homeDirectory, ".windsurf", "extensions"),
    path.join(homeDirectory, ".vscode-oss", "extensions"),
  ];
  const candidates = [];

  for (const extensionRoot of extensionRoots) {
    let extensions;
    try {
      extensions = await readDirectory(extensionRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    const codexExtensions = extensions
      .filter(
        (entry) =>
          entry.isDirectory() && entry.name.startsWith("openai.chatgpt-"),
      )
      .sort((left, right) =>
        right.name.localeCompare(left.name, undefined, { numeric: true }),
      );

    for (const extension of codexExtensions) {
      const binDirectory = path.join(extensionRoot, extension.name, "bin");
      candidates.push(path.join(binDirectory, executableName));
      try {
        const platformDirectories = await readDirectory(binDirectory, {
          withFileTypes: true,
        });
        for (const platformDirectory of platformDirectories) {
          if (platformDirectory.isDirectory()) {
            candidates.push(
              path.join(
                binDirectory,
                platformDirectory.name,
                executableName,
              ),
            );
          }
        }
      } catch {
        // 扩展可能未完整安装，继续检查其他版本或其他 IDE。
      }
    }
  }

  return candidates;
}

export async function resolveCodexCommand(options = {}) {
  if (options.codexCommand) return options.codexCommand;

  const environment = options.environment || process.env;
  const homeDirectory = options.homeDirectory || os.homedir();
  const platform = options.platform || process.platform;
  const accessFile =
    options.accessFile ||
    ((targetPath) => access(targetPath, fileConstants.X_OK));
  const executableName = platform === "win32" ? "codex.exe" : "codex";
  const pathCandidates = String(environment.PATH || "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, executableName));
  const applicationCandidates =
    platform === "darwin"
      ? [
          "/Applications/Codex.app/Contents/Resources/codex",
          "/Applications/ChatGPT.app/Contents/Resources/codex",
          path.join(
            homeDirectory,
            "Applications/Codex.app/Contents/Resources/codex",
          ),
          path.join(
            homeDirectory,
            "Applications/ChatGPT.app/Contents/Resources/codex",
          ),
        ]
      : [];
  const ideExtensionCandidates = await resolveIdeExtensionCandidates(options);
  const candidates = [
    environment.CODEX_CLI_PATH,
    ...pathCandidates,
    ...ideExtensionCandidates,
    ...applicationCandidates,
  ].filter(Boolean);

  for (const candidate of [...new Set(candidates)]) {
    try {
      await accessFile(candidate);
      return candidate;
    } catch {
      // 继续尝试 PATH 和 Codex Desktop 的其他标准安装位置。
    }
  }

  throw new Error(
    [
      "未找到 Codex CLI。",
      "请先安装 Codex Desktop、Codex VS Code 扩展，或 codex 命令行工具。",
      "如果 Codex 安装在自定义位置，请设置 CODEX_CLI_PATH 为 codex 可执行文件的绝对路径后重试。",
    ].join("\n"),
  );
}

export async function runCodex(args, options = {}) {
  const codexCommand = await resolveCodexCommand(options);
  try {
    return await execFileAsync(codexCommand, args, {
      cwd: options.cwd,
      encoding: "utf8",
      maxBuffer: 5 * 1024 * 1024,
    });
  } catch (error) {
    const details = String(error.stderr || error.stdout || error.message).trim();
    throw new Error(
      `Codex Plugin 命令执行失败：${codexCommand} ${args.join(" ")}\n${details}`,
      {
        cause: error,
      },
    );
  }
}

export async function installLocalPlugin(options = {}) {
  const repositoryRoot = path.resolve(
    options.repositoryRoot || resolveRepositoryRoot(),
  );
  const execute =
    options.execute ||
    ((args) =>
      runCodex(args, {
        codexCommand: options.codexCommand,
        environment: options.environment,
        homeDirectory: options.homeDirectory,
        platform: options.platform,
        accessFile: options.accessFile,
        cwd: repositoryRoot,
      }));

  const listed = await execute(["plugin", "marketplace", "list", "--json"]);
  const marketplaceOutput = String(listed.stdout || listed);
  let marketplaces;
  try {
    marketplaces = JSON.parse(marketplaceOutput).marketplaces ?? [];
  } catch {
    throw new Error("无法解析 Codex Marketplace 列表，请升级 Codex 后重试");
  }
  const configuredMarketplace = marketplaces.find(
    (marketplace) => marketplace.name === MARKETPLACE_NAME,
  );
  let marketplaceAdded = false;
  let marketplaceReplaced = false;
  let previousMarketplaceRoot;

  if (
    configuredMarketplace &&
    path.resolve(configuredMarketplace.root) !== repositoryRoot
  ) {
    previousMarketplaceRoot = configuredMarketplace.root;
    await execute(["plugin", "marketplace", "remove", MARKETPLACE_NAME]);
    marketplaceReplaced = true;
  }
  if (
    !configuredMarketplace ||
    marketplaceReplaced
  ) {
    await execute(["plugin", "marketplace", "add", repositoryRoot]);
    marketplaceAdded = true;
  }

  await execute(["plugin", "add", PLUGIN_SPEC]);
  return {
    repositoryRoot,
    marketplaceName: MARKETPLACE_NAME,
    pluginName: PLUGIN_NAME,
    pluginSpec: PLUGIN_SPEC,
    marketplaceAdded,
    marketplaceReplaced,
    previousMarketplaceRoot,
  };
}
