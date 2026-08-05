import { chmod, readdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  ensurePrivateDirectory,
  markdownCell,
  readJson,
  secureAtomicWrite,
  slugify,
  writeJson,
} from "./utils.mjs";

const DECISIONS = ["AUTO_FIX", "NEED_CONFIRM", "HUMAN_REQUIRED", "BLOCKED"];
const DECISION_LABELS = {
  AUTO_FIX: "可直接修改（等待用户确认修改）",
  NEED_CONFIRM: "等待确认",
  HUMAN_REQUIRED: "需要人工处理",
  BLOCKED: "仓库或环境待配置",
};

function contextList(values) {
  const items = Array.isArray(values) ? values : values ? [values] : [];
  if (items.length === 0) return "- 无";
  return items
    .map((item) => {
      if (typeof item !== "object" || item == null) return `- ${String(item)}`;
      const label = item.name || item.title || item.fileName || item.author || item.account || "条目";
      const content = item.content || item.text || item.comment || item.url || item.downloadUrl;
      return `- ${label}${content ? `：${String(content).replace(/\r?\n/g, " ")}` : ""}`;
    })
    .join("\n");
}

function bugMarkdown(item) {
  const questions = item.triage.questions.length
    ? item.triage.questions.map((question) => `- ${question}`).join("\n")
    : "- 无";
  const reasons = item.triage.reasons.map((reason) => `- ${reason}`).join("\n");
  const aiAnalysis = item.aiAnalysis
    ? `## Codex 语义分析

- 核心问题：${item.aiAnalysis.summary}
- 用户类型：${item.aiAnalysis.problemType}
- 内部子类型：${item.aiAnalysis.subtype || "未提供"}
- 是否需要确认：${item.aiAnalysis.needsConfirmation ? "是" : "否"}
- 确认问题：${item.aiAnalysis.confirmationQuestion || "无"}
- 建议修改：${item.aiAnalysis.proposedChange || "未提供"}
- 风险：${item.aiAnalysis.risk}
- 分析时间：${item.aiAnalysis.analyzedAt}

### 证据

${item.aiAnalysis.evidence.length ? item.aiAnalysis.evidence.map((value) => `- ${value}`).join("\n") : "- 无"}

`
    : "";
  return `# Bug ${item.bug.id}：${item.bug.title || "（无标题）"}

## 禅道信息

- 产品：${item.bug.product || "未提供"}
- 禅道项目：${item.bug.project || "未提供"}
- 所属执行：${item.bug.executionName || "未提供"}（ID：${item.bug.execution || "未提供"}）
- 代码仓库线索：${item.bug.repositoryProject || "未提供"}
- 线索来源：${item.bug.repositoryProjectSource || "未识别"}${item.bug.repositoryProjectLabel ? `（${item.bug.repositoryProjectLabel}）` : ""}
- 仓库映射 Key：${item.repositoryKey || "未提供"}
- 模块：${item.bug.module || "未提供"}
- 状态：${item.bug.status || "未提供"}
- 严重程度：${item.bug.severity ?? "未提供"}
- 优先级：${item.bug.priority ?? "未提供"}
- 影响版本：${item.bug.affectedVersion || "未提供"}
- 解决版本：${item.bug.resolvedVersion || "未提供"}
- 链接：${item.bug.url || "未提供"}

## 描述

${item.bug.description || "未提供"}

## 复现步骤

${item.bug.steps || "未提供"}

## 附件

${contextList(item.bug.attachments)}

## 评论

${contextList(item.bug.comments)}

${aiAnalysis}## 分诊结论

- 类型：${item.triage.category}
- 处理结论：${item.triage.decision}
- 置信度：${item.triage.confidence}
- 详情获取状态：${item.bug.fetchStatus || "complete"}
- 仓库：${item.repository?.repoPath || "未匹配"}
- 下一步：${item.triage.nextAction}

### 理由

${reasons}

### 待确认问题

${questions}
`;
}

function summaryMarkdown(report) {
  const counts = DECISIONS.map(
    (decision) => `- ${DECISION_LABELS[decision]}：${report.stats.byDecision[decision] ?? 0}`,
  ).join("\n");
  const groups = DECISIONS.map((decision) => {
    const rows = report.items
      .filter((item) => item.triage.decision === decision)
      .map(
        (item) =>
          `| ${markdownCell(item.bug.id)} | ${markdownCell(item.bug.title)} | ${markdownCell(item.bug.repositoryProject || "未识别")} | ${markdownCell(item.bug.repositoryProjectSource || "-")} | ${markdownCell(item.bug.executionName || item.bug.execution || "未提供")} | ${item.triage.category} | ${markdownCell(item.repository?.name || "未匹配")} | ${item.triage.confidence} |`,
      )
      .join("\n");
    return `## ${DECISION_LABELS[decision]}

| Bug | 标题 | 代码仓库线索 | 来源 | 所属执行 | 类型 | 仓库 | 置信度 |
| --- | --- | --- | --- | --- | --- | --- | --- |
${rows || "| - | 暂无 | - | - | - | - | - | - |"}`;
  }).join("\n\n");
  return `# 禅道前端 Bug 分诊报告

- 生成时间：${report.generatedAt}
- 当前用户：${report.currentUser}
- Bug 总数：${report.stats.total}
- 报告范围：${report.completeList ? "完整个人 Bug 清单" : "单 Bug 报告"}
- 数据获取：完整 ${report.fetchSummary.complete}，详情失败 ${report.fetchSummary.detailFailed}，数据源失败 ${report.fetchSummary.sourceErrorCount}
- 拉取模式：${report.requestSummary?.listMode || "未记录"}
- 拉取耗时：${Number.isFinite(report.timings?.totalMs) ? `${(report.timings.totalMs / 1000).toFixed(2)} 秒` : "未记录"}
- 禅道候选：${report.requestSummary?.personalCandidateCount ?? "未记录"}，详情请求：${report.requestSummary?.detailRequests ?? "未记录"}

## 处理结论统计

${counts}

${groups}

详细上下文见同目录下的 \`bugs/\`。
`;
}

function fetchSummaryFor(items, sourceErrors = []) {
  const detailFailed = items.filter(
    (item) => item?.bug?.fetchStatus === "detail_failed",
  ).length;
  return {
    status: detailFailed > 0 || sourceErrors.length > 0 ? "partial" : "complete",
    complete: items.length - detailFailed,
    detailFailed,
    sourceErrorCount: sourceErrors.length,
  };
}

function upgradeReport(report) {
  if (!report || typeof report !== "object" || !Array.isArray(report.items)) {
    throw new Error("分诊报告格式无效：缺少 items 数组");
  }
  const sourceErrors = Array.isArray(report.sourceErrors) ? report.sourceErrors : [];
  return {
    ...report,
    schemaVersion: 2,
    scope: report.scope || "complete-list",
    completeList: report.completeList !== false,
    sourceErrors,
    fetchSummary: report.fetchSummary || fetchSummaryFor(report.items, sourceErrors),
    requestSummary: report.requestSummary || {},
    timings: report.timings || {},
  };
}

export async function readTriageReport(reportPath) {
  await ensurePrivateDirectory(path.dirname(reportPath));
  await chmod(reportPath, 0o600);
  return upgradeReport(await readJson(reportPath));
}

async function removeStaleBugReports(bugsDir, currentNames) {
  let entries;
  try {
    entries = await readdir(bugsDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isFile() && entry.name.endsWith(".md") && !currentNames.has(entry.name),
      )
      .map((entry) => rm(path.join(bugsDir, entry.name))),
  );
}

export async function writeTriageReport(config, items, options = {}) {
  const sourceErrors = options.sourceErrors ?? items.sourceErrors ?? [];
  const requestSummary = options.requestSummary ?? items.requestSummary ?? {};
  const timings = options.timings ?? items.timings ?? {};
  const byDecision = Object.fromEntries(DECISIONS.map((decision) => [decision, 0]));
  const byCategory = {};
  for (const item of items) {
    byDecision[item.triage.decision] += 1;
    byCategory[item.triage.category] = (byCategory[item.triage.category] ?? 0) + 1;
  }
  const report = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    currentUser: config.currentUser,
    configPath: config.__configPath,
    scope: options.scope || "complete-list",
    completeList: options.completeList !== false,
    stats: { total: items.length, byDecision, byCategory },
    fetchSummary: fetchSummaryFor(items, sourceErrors),
    sourceErrors,
    requestSummary,
    timings,
    items,
  };

  const bugsDir = path.join(config.outputDir, "bugs");
  await ensurePrivateDirectory(config.outputDir);
  await ensurePrivateDirectory(bugsDir);
  await writeJson(path.join(config.outputDir, "triage.json"), report);
  await secureAtomicWrite(
    path.join(config.outputDir, "triage.md"),
    summaryMarkdown(report),
  );
  const currentNames = new Set(
    items.map((item) => `${slugify(item.bug.id, "unknown")}.md`),
  );
  if (report.completeList) {
    await removeStaleBugReports(bugsDir, currentNames);
  }
  await Promise.all(
    items.map((item) =>
      secureAtomicWrite(
        path.join(bugsDir, `${slugify(item.bug.id, "unknown")}.md`),
        bugMarkdown(item),
      ),
    ),
  );
  return {
    report,
    jsonPath: path.join(config.outputDir, "triage.json"),
    markdownPath: path.join(config.outputDir, "triage.md"),
  };
}
