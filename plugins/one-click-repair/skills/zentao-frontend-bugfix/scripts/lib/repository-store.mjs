import { chmod } from "node:fs/promises";
import path from "node:path";

import { inspectRepository, repositoryKeyForProject } from "./repository.mjs";
import { readJson, writeJson } from "./utils.mjs";

export async function storeRepositoryByProject(configPath, projectName, repoPath) {
  const name = String(projectName || "").trim();
  const key = repositoryKeyForProject(name);
  if (!key) throw new Error("所属项目名称不能为空");

  const absoluteRepoPath = path.resolve(repoPath);
  const inspected = await inspectRepository({
    name: path.basename(absoluteRepoPath),
    repoPath: absoluteRepoPath,
  });
  if (!inspected.available) throw new Error(inspected.blocker);

  const raw = await readJson(configPath);
  raw.repositoriesByProject = {
    ...(raw.repositoriesByProject ?? {}),
    [key]: absoluteRepoPath,
  };
  await writeJson(configPath, raw);
  await chmod(configPath, 0o600);
  return {
    projectKey: key,
    projectName: name,
    repoPath: absoluteRepoPath,
    configPath,
  };
}
