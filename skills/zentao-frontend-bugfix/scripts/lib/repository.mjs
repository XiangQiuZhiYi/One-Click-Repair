import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { printableValue } from "./utils.mjs";

export function repositoryKeyForBug(bug) {
  const execution = printableValue(bug.execution).trim();
  if (execution && execution !== "0") return execution;
  return `no-execution:${bug.product || "unknown"}:${bug.project || "0"}`;
}

export function findRepository(bug, repositoriesByExecution) {
  const executionKey = repositoryKeyForBug(bug);
  const mapping = repositoriesByExecution?.[executionKey];
  if (!mapping) return undefined;
  return {
    name: mapping.name,
    repoPath: mapping.repoPath,
    executionKey,
  };
}

export async function inspectRepository(repository) {
  if (!repository) return undefined;
  try {
    const info = await stat(repository.repoPath);
    if (!info.isDirectory()) throw new Error("not a directory");
    await access(repository.repoPath, constants.R_OK | constants.W_OK);
    const packageJsonPath = path.join(repository.repoPath, "package.json");
    let hasPackageJson = true;
    try {
      await access(packageJsonPath, constants.R_OK);
    } catch {
      hasPackageJson = false;
    }
    return {
      ...repository,
      available: true,
      workspacePath: repository.repoPath,
      hasPackageJson,
    };
  } catch (error) {
    return {
      ...repository,
      available: false,
      blocker: `仓库目录不存在、不可读写或不是目录：${repository.repoPath}`,
    };
  }
}
