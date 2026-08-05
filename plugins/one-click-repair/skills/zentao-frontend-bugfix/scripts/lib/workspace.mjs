import { access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { readTriageReport } from "./report.mjs";
import { slugify, writeJson } from "./utils.mjs";

const AUTHORIZATION_BASES = new Set([
  "explicit-confirmation",
  "user-provided-solution",
]);

export async function selectCurrentWorkspace(config, reportPath, bugId, options = {}) {
  if (options.confirmed !== true) {
    throw new Error("用户尚未用自然语言明确授权修改，不能进入代码修改阶段");
  }
  const authorizationBasis =
    options.authorizationBasis || "explicit-confirmation";
  if (!AUTHORIZATION_BASES.has(authorizationBasis)) {
    throw new Error(`不支持的修改授权依据：${authorizationBasis}`);
  }
  const report = await readTriageReport(reportPath);
  const item = report.items.find((candidate) => String(candidate.bug.id) === String(bugId));
  if (!item) throw new Error(`分诊报告中找不到 Bug：${bugId}`);
  if (item.triage.decision === "BLOCKED") {
    throw new Error(`Bug ${bugId} 仍存在仓库或环境阻塞，不能进入代码修改阶段`);
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
    userAuthorization: {
      basis: authorizationBasis,
      overridesTriageDecision: item.triage.decision !== "AUTO_FIX",
    },
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
