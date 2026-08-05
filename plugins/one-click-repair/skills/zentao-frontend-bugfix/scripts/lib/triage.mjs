import { classifyBug } from "./classifier.mjs";
import { normalizeAndFilterBugs } from "./normalize.mjs";
import { findRepository, inspectRepository, repositoryKeyForBug } from "./repository.mjs";
import { loadRawBugById, loadRawBugsWithMetadata } from "./source.mjs";

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
      triage: classifyBug(bug, repository, config.policy, existingItem.aiAnalysis),
    };
  }));
}

export async function triageBugs(config, options = {}) {
  const loaded = await loadRawBugsWithMetadata(config, options);
  const bugs = normalizeAndFilterBugs(loaded.items, config);
  const items = await retriageExistingItems(
    config,
    bugs.map((bug) => ({ bug })),
  );
  Object.defineProperty(items, "sourceErrors", {
    value: loaded.sourceErrors ?? [],
    enumerable: false,
  });
  Object.defineProperty(items, "requestSummary", {
    value: { ...(loaded.requestSummary ?? {}), matchedBugCount: items.length },
    enumerable: false,
  });
  Object.defineProperty(items, "timings", {
    value: loaded.timings ?? {},
    enumerable: false,
  });
  return items;
}

export async function triageBugById(config, bugId, options = {}) {
  const rawBug = await loadRawBugById(config, bugId, options);
  const [bug] = normalizeAndFilterBugs([rawBug], config);
  const assignedToCurrentUser =
    config.source.filterAssignedToCurrentUser === false ||
    bug?.assignee?.toLocaleLowerCase() === config.currentUser.toLocaleLowerCase();
  if (!bug || !assignedToCurrentUser) {
    throw new Error(`Bug ${bugId} 已关闭、未指派给当前账号或不存在`);
  }
  const [item] = await retriageExistingItems(config, [{ bug }]);
  return item;
}
