import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { printableValue } from "./utils.mjs";

export function repositoryKeyForProject(projectName) {
  return printableValue(projectName).trim().toLocaleLowerCase();
}

function comparableRepositoryName(value) {
  return repositoryKeyForProject(value).replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

export function repositoryKeyForBug(bug) {
  return repositoryKeyForProject(bug.repositoryProject);
}

export function findRepository(bug, repositoriesByProject) {
  const projectKey = repositoryKeyForBug(bug);
  if (!projectKey) return undefined;
  const entries = Object.entries(repositoriesByProject ?? {});
  const exact = entries.find(([key]) => repositoryKeyForProject(key) === projectKey);
  let selected = exact;
  let matchType = "exact";

  if (!selected) {
    const query = comparableRepositoryName(projectKey);
    const candidates = entries.filter(([key, mapping]) => {
      const names = [
        key,
        mapping?.projectName,
        mapping?.name,
        mapping?.repoPath ? path.basename(mapping.repoPath) : "",
      ]
        .map(comparableRepositoryName)
        .filter((name) => name.length >= 3);
      return (
        query.length >= 3 &&
        names.some((name) => name === query || name.includes(query) || query.includes(name))
      );
    });
    if (candidates.length === 1) {
      [selected] = candidates;
      matchType = "fuzzy";
    }
  }

  if (!selected) return undefined;
  const [matchedKey, mapping] = selected;
  return {
    name: mapping.name,
    repoPath: mapping.repoPath,
    projectKey: repositoryKeyForProject(matchedKey),
    projectName: bug.repositoryProject,
    requestedProjectKey: projectKey,
    matchType,
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
