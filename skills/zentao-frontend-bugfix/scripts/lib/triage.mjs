import { classifyBug } from "./classifier.mjs";
import { normalizeAndFilterBugs } from "./normalize.mjs";
import { findRepository, inspectRepository, repositoryKeyForBug } from "./repository.mjs";
import { loadRawBugs } from "./source.mjs";

export async function triageBugs(config, options = {}) {
  const rawBugs = await loadRawBugs(config, options);
  const bugs = normalizeAndFilterBugs(rawBugs, config);
  const inspections = new Map();

  return Promise.all(bugs.map(async (bug) => {
    const repositoryKey = repositoryKeyForBug(bug);
    const matched = findRepository(bug, config.repositoriesByExecution);
    let repository;
    if (matched) {
      if (!inspections.has(matched.repoPath)) {
        inspections.set(matched.repoPath, inspectRepository(matched));
      }
      repository = await inspections.get(matched.repoPath);
    }
    return {
      bug,
      repositoryKey,
      repository,
      triage: classifyBug(bug, repository, config.policy),
    };
  }));
}
