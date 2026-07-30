import { classifyBug } from "./classifier.mjs";
import { normalizeAndFilterBugs } from "./normalize.mjs";
import { findRepository, inspectRepository, repositoryKeyForBug } from "./repository.mjs";
import { loadRawBugs } from "./source.mjs";

export async function retriageExistingItems(config, existingItems) {
  if (!Array.isArray(existingItems)) {
    throw new Error("现有分诊报告缺少 items 数组");
  }
  const inspections = new Map();

  return Promise.all(existingItems.map(async (existingItem) => {
    const bug = existingItem?.bug;
    if (!bug || typeof bug !== "object") {
      throw new Error("现有分诊报告包含无效的 Bug 条目");
    }
    const repositoryKey = repositoryKeyForBug(bug);
    const matched = findRepository(bug, config.repositoriesByProject);
    let repository;
    if (matched) {
      if (!inspections.has(matched.repoPath)) {
        inspections.set(matched.repoPath, inspectRepository(matched));
      }
      repository = await inspections.get(matched.repoPath);
    }
    return {
      ...existingItem,
      bug,
      repositoryKey,
      repository,
      triage: classifyBug(bug, repository, config.policy),
    };
  }));
}

export async function triageBugs(config, options = {}) {
  const rawBugs = await loadRawBugs(config, options);
  const bugs = normalizeAndFilterBugs(rawBugs, config);
  return retriageExistingItems(
    config,
    bugs.map((bug) => ({ bug })),
  );
}
