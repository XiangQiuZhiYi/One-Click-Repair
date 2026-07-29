import { chmod } from "node:fs/promises";
import path from "node:path";

import { inspectRepository } from "./repository.mjs";
import { readJson, writeJson } from "./utils.mjs";

export async function storeRepositoryByExecution(configPath, executionKey, repoPath) {
  const key = String(executionKey || "").trim();
  if (!key) throw new Error("所属执行 key 不能为空");

  const absoluteRepoPath = path.resolve(repoPath);
  const inspected = await inspectRepository({
    name: path.basename(absoluteRepoPath),
    repoPath: absoluteRepoPath,
  });
  if (!inspected.available) throw new Error(inspected.blocker);

  const raw = await readJson(configPath);
  raw.repositoriesByExecution = {
    ...(raw.repositoriesByExecution ?? {}),
    [key]: absoluteRepoPath,
  };
  delete raw.projectMappings;
  await writeJson(configPath, raw);
  await chmod(configPath, 0o600);
  return {
    executionKey: key,
    repoPath: absoluteRepoPath,
    configPath,
  };
}
