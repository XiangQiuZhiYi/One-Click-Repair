import { access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { readJson, slugify, writeJson } from "./utils.mjs";

export async function selectCurrentWorkspace(config, reportPath, bugId, options = {}) {
  if (options.confirmed !== true) {
    throw new Error("用户尚未用自然语言明确授权修改，不能进入代码修改阶段");
  }
  const report = await readJson(reportPath);
  const item = report.items.find((candidate) => String(candidate.bug.id) === String(bugId));
  if (!item) throw new Error(`分诊报告中找不到 Bug：${bugId}`);
  if (item.triage.decision !== "AUTO_FIX") {
    throw new Error(`Bug ${bugId} 的处理结论是 ${item.triage.decision}，不能准备自动修复工作区`);
  }
  if (!item.repository?.repoPath) throw new Error(`Bug ${bugId} 没有仓库路径`);

  const repoPath = item.repository.repoPath;
  try {
    await access(repoPath, constants.R_OK | constants.W_OK);
  } catch {
    throw new Error(`Bug ${bugId} 的当前仓库目录不可读写：${repoPath}`);
  }

  const metadata = {
    schemaVersion: 1,
    selectedAt: new Date().toISOString(),
    bug: item.bug,
    triage: item.triage,
    repository: item.repository,
    workspaceMode: "current",
    workspacePath: repoPath,
    userConfirmed: true,
    verificationMode: "code-logic-review",
  };
  const metadataPath = path.join(
    config.outputDir,
    "workspaces",
    `${slugify(item.bug.id, "unknown")}.json`,
  );
  await writeJson(metadataPath, metadata);
  return { metadata, metadataPath };
}
