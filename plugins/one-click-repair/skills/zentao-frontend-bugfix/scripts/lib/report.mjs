import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { markdownCell, slugify, writeJson } from "./utils.mjs";

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

## 分诊结论

- 类型：${item.triage.category}
- 处理结论：${item.triage.decision}
- 置信度：${item.triage.confidence}
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

## 处理结论统计

${counts}

${groups}

详细上下文见同目录下的 \`bugs/\`。
`;
}

export async function writeTriageReport(config, items) {
  const byDecision = Object.fromEntries(DECISIONS.map((decision) => [decision, 0]));
  const byCategory = {};
  for (const item of items) {
    byDecision[item.triage.decision] += 1;
    byCategory[item.triage.category] = (byCategory[item.triage.category] ?? 0) + 1;
  }
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    currentUser: config.currentUser,
    configPath: config.__configPath,
    stats: { total: items.length, byDecision, byCategory },
    items,
  };

  const bugsDir = path.join(config.outputDir, "bugs");
  await mkdir(bugsDir, { recursive: true });
  await writeJson(path.join(config.outputDir, "triage.json"), report);
  await writeFile(path.join(config.outputDir, "triage.md"), summaryMarkdown(report), "utf8");
  await Promise.all(
    items.map((item) =>
      writeFile(
        path.join(bugsDir, `${slugify(item.bug.id, "unknown")}.md`),
        bugMarkdown(item),
        "utf8",
      ),
    ),
  );
  return {
    report,
    jsonPath: path.join(config.outputDir, "triage.json"),
    markdownPath: path.join(config.outputDir, "triage.md"),
  };
}
