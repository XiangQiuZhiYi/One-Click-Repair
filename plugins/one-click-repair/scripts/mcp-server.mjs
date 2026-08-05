#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

import {
  downloadBugImage,
  findBugAttachment,
} from "../skills/zentao-frontend-bugfix/scripts/lib/attachment.mjs";
import {
  ensureZentaoToken,
  findStoredToken,
  withAutomaticTokenRefresh,
} from "../skills/zentao-frontend-bugfix/scripts/lib/auth.mjs";
import { findDefaultConfigPath } from "../skills/zentao-frontend-bugfix/scripts/lib/config-path.mjs";
import { loadConfig } from "../skills/zentao-frontend-bugfix/scripts/lib/config.mjs";
import {
  readTriageReport,
  writeTriageReport,
} from "../skills/zentao-frontend-bugfix/scripts/lib/report.mjs";
import {
  findRepository,
  inspectRepository,
  repositoryKeyForProject,
} from "../skills/zentao-frontend-bugfix/scripts/lib/repository.mjs";
import { storeRepositoryByProject } from "../skills/zentao-frontend-bugfix/scripts/lib/repository-store.mjs";
import {
  retriageExistingItems,
  triageBugById,
  triageBugs,
} from "../skills/zentao-frontend-bugfix/scripts/lib/triage.mjs";
import { selectCurrentWorkspace } from "../skills/zentao-frontend-bugfix/scripts/lib/workspace.mjs";

const SERVER_NAME = "one-click-repair";
const SERVER_VERSION = "0.11.0";

const optionalConfigPathSchema = {
  config_path: z
    .string()
    .min(1)
    .optional()
    .describe("可选的禅道配置绝对路径；日常使用时不要传"),
};

function toolResult(data, message, options = {}) {
  return {
    structuredContent: data,
    content: [
      {
        type: "text",
        text: options.includeJson === false
          ? message
          : `${message}\n${JSON.stringify(data, null, 2)}`,
      },
    ],
  };
}

async function hasNonEmptyFile(filePath) {
  if (!filePath) return false;
  try {
    return Boolean((await readFile(filePath, "utf8")).trim());
  } catch {
    return false;
  }
}

async function resolveConfig(configPath) {
  const resolvedPath = await findDefaultConfigPath(
    configPath ? { config: configPath } : {},
  );
  return {
    configPath: resolvedPath,
    config: await loadConfig(resolvedPath),
  };
}

async function readCurrentReport(config, reportPath) {
  const expectedReportPath = path.resolve(config.outputDir, "triage.json");
  const requestedReportPath = path.resolve(reportPath);
  if (requestedReportPath !== expectedReportPath) {
    throw new Error(`report_path 必须是本次配置生成的分诊报告：${expectedReportPath}`);
  }
  return {
    reportPath: requestedReportPath,
    report: await readTriageReport(requestedReportPath),
  };
}

async function readExistingCurrentReport(config, reportPath) {
  try {
    return await readCurrentReport(
      config,
      reportPath || path.resolve(config.outputDir, "triage.json"),
    );
  } catch (error) {
    if (!reportPath && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function collectTriage(config, onProgress) {
  const token = await ensureZentaoToken(config);
  onProgress?.("认证完成，正在读取指派给我的 Bug");
  const triage = await withAutomaticTokenRefresh(
    config,
    () => triageBugs(config, { onProgress }),
  );
  const written = await writeTriageReport(config, triage.value, {
    sourceErrors: triage.value.sourceErrors,
    requestSummary: triage.value.requestSummary,
    timings: triage.value.timings,
  });
  return {
    reportPath: written.jsonPath,
    summaryPath: written.markdownPath,
    stats: written.report.stats,
    fetchSummary: written.report.fetchSummary,
    sourceErrors: written.report.sourceErrors,
    requestSummary: written.report.requestSummary,
    timings: written.report.timings,
    items: written.report.items,
    tokenSource: token.source,
    tokenAutoRefreshed: Boolean(token.refreshed || triage.tokenAutoRefreshed),
  };
}

export async function getZentaoAuthStatus(input = {}) {
  try {
    const { configPath, config } = await resolveConfig(input.config_path);
    const token = await findStoredToken(config);
    const accountReady =
      Boolean(config.currentUser?.trim()) ||
      (await hasNonEmptyFile(config.source.accountFile));
    return {
      configured: true,
      setupRequired: !accountReady,
      accountReady,
      tokenReady: token.ready,
      tokenSource: token.source,
      configPath,
      baseUrl: config.source.baseUrl,
      message: accountReady
        ? "账号已初始化；Token 缺失或失效时会使用本地钥匙串自动刷新。"
        : "尚未初始化账号，请运行 npx one-click-repair@latest setup（源码安装可运行 npm run bootstrap）。",
    };
  } catch (error) {
    return {
      configured: false,
      setupRequired: true,
      accountReady: false,
      tokenReady: false,
      message: error.message,
    };
  }
}

export async function listMyZentaoBugs(input = {}, options = {}) {
  const { configPath, config } = await resolveConfig(input.config_path);
  const parsedCursor = Number(input.cursor ?? 0);
  const cursor = Number.isSafeInteger(parsedCursor) && parsedCursor >= 0
    ? parsedCursor
    : 0;
  let result;
  if (input.response_mode === "summary" && cursor > 0) {
    const existing = await readCurrentReport(
      config,
      path.resolve(config.outputDir, "triage.json"),
    );
    result = {
      configPath,
      reportPath: existing.reportPath,
      summaryPath: path.resolve(config.outputDir, "triage.md"),
      stats: existing.report.stats,
      fetchSummary: existing.report.fetchSummary,
      sourceErrors: existing.report.sourceErrors,
      requestSummary: existing.report.requestSummary,
      timings: existing.report.timings,
      items: existing.report.items,
      tokenSource: "not-requested",
      tokenAutoRefreshed: false,
      zentaoRequested: false,
    };
  } else {
    result = {
      configPath,
      ...(await collectTriage(config, options.onProgress)),
      zentaoRequested: true,
    };
  }
  if (input.response_mode !== "summary") return result;

  const parsedLimit = Number(input.limit ?? 50);
  const limit = Number.isSafeInteger(parsedLimit) && parsedLimit >= 1
    ? Math.min(parsedLimit, 100)
    : 50;
  const pageItems = result.items.slice(cursor, cursor + limit).map((item) => ({
    bugId: item.bug.id,
    title: item.bug.title,
    repositoryProject: item.bug.repositoryProject,
    repositoryProjectSource: item.bug.repositoryProjectSource,
    execution: item.bug.execution,
    executionName: item.bug.executionName,
    affectedVersion: item.bug.affectedVersion,
    fetchStatus: item.bug.fetchStatus || "complete",
    attachmentCount: item.bug.attachments?.length ?? 0,
    triage: item.triage,
    repository: item.repository
      ? {
          name: item.repository.name,
          projectKey: item.repository.projectKey,
          available: item.repository.available,
        }
      : undefined,
  }));
  const nextOffset = cursor + pageItems.length;
  return {
    configPath: result.configPath,
    reportPath: result.reportPath,
    summaryPath: result.summaryPath,
    stats: result.stats,
    fetchSummary: result.fetchSummary,
    sourceErrors: result.sourceErrors,
    requestSummary: result.requestSummary,
    timings: result.timings,
    tokenSource: result.tokenSource,
    tokenAutoRefreshed: result.tokenAutoRefreshed,
    zentaoRequested: result.zentaoRequested,
    responseMode: "summary",
    cursor: String(cursor),
    nextCursor: nextOffset < result.items.length ? String(nextOffset) : undefined,
    items: pageItems,
  };
}

export async function getZentaoBugDetail(input) {
  const { configPath, config } = await resolveConfig(input.config_path);
  const existing = await readExistingCurrentReport(config, input.report_path);
  const bugId = String(input.bug_id);
  const cachedItem = existing?.report.items.find(
    (candidate) => String(candidate.bug.id) === bugId,
  );
  if (cachedItem && input.refresh !== true) {
    return {
      configPath,
      reportPath: existing.reportPath,
      summaryPath: path.resolve(config.outputDir, "triage.md"),
      source: "local-report",
      zentaoRequested: false,
      item: cachedItem,
    };
  }

  await ensureZentaoToken(config);
  const refreshed = await withAutomaticTokenRefresh(config, () =>
    triageBugById(config, bugId),
  );
  const refreshedBug = {
    ...refreshed.value.bug,
    ...(cachedItem?.bug?.userSupplement
      ? { userSupplement: cachedItem.bug.userSupplement }
      : {}),
  };
  const [refreshedItem] = await retriageExistingItems(config, [
    {
      ...refreshed.value,
      ...(cachedItem?.aiAnalysis ? { aiAnalysis: cachedItem.aiAnalysis } : {}),
      bug: refreshedBug,
    },
  ]);
  const items = existing
    ? cachedItem
      ? existing.report.items.map((candidate) =>
          String(candidate.bug.id) === bugId ? refreshedItem : candidate,
        )
      : [...existing.report.items, refreshedItem]
    : [refreshedItem];
  const written = await writeTriageReport(config, items, {
    scope: existing?.report.scope || "single-bug",
    completeList: existing?.report.completeList ?? false,
    sourceErrors: existing?.report.sourceErrors || [],
    requestSummary: existing?.report.requestSummary || {},
    timings: existing?.report.timings || {},
  });
  return {
    configPath,
    reportPath: written.jsonPath,
    summaryPath: written.markdownPath,
    source: "zentao-detail",
    zentaoRequested: true,
    tokenAutoRefreshed: refreshed.tokenAutoRefreshed,
    item: refreshedItem,
  };
}

export async function getRepositoryByProject(input) {
  const { configPath, config } = await resolveConfig(input.config_path);
  const projectName = String(input.project_name).trim();
  const projectKey = repositoryKeyForProject(projectName);
  const mapping = findRepository(
    { repositoryProject: projectName },
    config.repositoriesByProject,
  );
  if (!mapping) {
    return {
      found: false,
      projectKey,
      projectName,
      configPath,
    };
  }
  const repository = await inspectRepository({
    ...mapping,
    projectName,
  });
  return {
    found: true,
    projectKey: repository.projectKey,
    requestedProjectKey: projectKey,
    matchType: repository.matchType,
    projectName,
    configPath,
    repository,
  };
}

export async function setRepositoryByProject(input) {
  const { configPath, config: currentConfig } = await resolveConfig(
    input.config_path,
  );
  let existingReport;
  let requestedReportPath;
  if (input.report_path) {
    const current = await readCurrentReport(currentConfig, input.report_path);
    requestedReportPath = current.reportPath;
    existingReport = current.report;
  }
  const stored = await storeRepositoryByProject(
    configPath,
    input.project_name,
    input.repository_path,
  );
  let reportRefresh = {
    refreshed: false,
    source: "not-requested",
  };
  if (existingReport) {
    const config = await loadConfig(configPath);
    const items = await retriageExistingItems(config, existingReport.items);
    const written = await writeTriageReport(config, items, {
      scope: existingReport.scope,
      completeList: existingReport.completeList,
      sourceErrors: existingReport.sourceErrors,
      requestSummary: existingReport.requestSummary,
      timings: existingReport.timings,
    });
    reportRefresh = {
      refreshed: true,
      source: "local-report",
      zentaoRequested: false,
      reportPath: written.jsonPath,
      summaryPath: written.markdownPath,
      stats: written.report.stats,
      items: written.report.items,
    };
  }
  return {
    saved: true,
    ...stored,
    reportRefresh,
  };
}

export async function applyBugUserSupplement(input) {
  const { configPath, config } = await resolveConfig(input.config_path);
  const { report } = await readCurrentReport(config, input.report_path);
  const bugId = String(input.bug_id);
  const item = report.items.find(
    (candidate) => String(candidate?.bug?.id) === bugId,
  );
  if (!item) throw new Error(`分诊报告中找不到 Bug：${bugId}`);

  const hasSupplement =
    input.repository_project != null ||
    input.problem_type != null ||
    input.needs_confirmation != null ||
    input.note != null;
  if (!hasSupplement) {
    throw new Error("至少需要提供一项用户补充信息");
  }

  const userSupplement = {
    ...(item.bug.userSupplement ?? {}),
    ...(input.problem_type != null ? { problemType: input.problem_type } : {}),
    ...(input.needs_confirmation != null
      ? { needsConfirmation: input.needs_confirmation }
      : {}),
    ...(input.note != null ? { note: String(input.note).trim() } : {}),
    updatedAt: new Date().toISOString(),
  };
  const repositoryProject = String(input.repository_project ?? "").trim();
  const updatedItems = report.items.map((candidate) => {
    if (String(candidate?.bug?.id) !== bugId) return candidate;
    return {
      ...candidate,
      bug: {
        ...candidate.bug,
        ...(repositoryProject
          ? {
              repositoryProject,
              repositoryProjectSource: "chat",
              repositoryProjectLabel: "用户补充",
            }
          : {}),
        userSupplement,
      },
    };
  });
  const items = await retriageExistingItems(config, updatedItems);
  const written = await writeTriageReport(config, items, {
    scope: report.scope,
    completeList: report.completeList,
    sourceErrors: report.sourceErrors,
    requestSummary: report.requestSummary,
    timings: report.timings,
  });
  const updatedItem = written.report.items.find(
    (candidate) => String(candidate.bug.id) === bugId,
  );
  return {
    updated: true,
    source: "chat-supplement",
    zentaoRequested: false,
    configPath,
    reportPath: written.jsonPath,
    summaryPath: written.markdownPath,
    stats: written.report.stats,
    item: updatedItem,
  };
}

export async function recordBugAnalyses(input) {
  const { configPath, config } = await resolveConfig(input.config_path);
  const { report } = await readCurrentReport(config, input.report_path);
  const analyses = input.analyses ?? [];
  const bugIds = analyses.map((analysis) => String(analysis.bug_id));
  if (new Set(bugIds).size !== bugIds.length) {
    throw new Error("同一次分析保存中不能包含重复的 Bug ID");
  }
  const knownIds = new Set(report.items.map((item) => String(item.bug.id)));
  const missing = bugIds.filter((bugId) => !knownIds.has(bugId));
  if (missing.length) {
    throw new Error(`分诊报告中找不到 Bug：${missing.join("、")}`);
  }

  const analyzedAt = new Date().toISOString();
  const analysesById = new Map(
    analyses.map((analysis) => [
      String(analysis.bug_id),
      {
        summary: analysis.summary.trim(),
        problemType: analysis.problem_type,
        ...(analysis.subtype ? { subtype: analysis.subtype.trim() } : {}),
        needsConfirmation: analysis.needs_confirmation,
        ...(analysis.confirmation_question
          ? { confirmationQuestion: analysis.confirmation_question.trim() }
          : {}),
        evidence: analysis.evidence.map((value) => value.trim()),
        ...(analysis.proposed_change
          ? { proposedChange: analysis.proposed_change.trim() }
          : {}),
        risk: analysis.risk,
        analyzedAt,
        source: "codex",
      },
    ]),
  );
  const updatedItems = report.items.map((item) => {
    const aiAnalysis = analysesById.get(String(item.bug.id));
    return aiAnalysis ? { ...item, aiAnalysis } : item;
  });
  const items = await retriageExistingItems(config, updatedItems);
  const written = await writeTriageReport(config, items, {
    scope: report.scope,
    completeList: report.completeList,
    sourceErrors: report.sourceErrors,
    requestSummary: report.requestSummary,
    timings: report.timings,
  });
  return {
    updated: true,
    source: "codex-analysis",
    zentaoRequested: false,
    configPath,
    reportPath: written.jsonPath,
    summaryPath: written.markdownPath,
    count: analyses.length,
    results: bugIds.map((bugId) => {
      const item = written.report.items.find(
        (candidate) => String(candidate.bug.id) === bugId,
      );
      return {
        bugId,
        category: item.triage.category,
        decision: item.triage.decision,
        needsConfirmation: item.aiAnalysis.needsConfirmation,
      };
    }),
  };
}

export async function getZentaoBugAttachment(input, options = {}) {
  const { configPath, config } = await resolveConfig(input.config_path);
  const { report } = await readCurrentReport(config, input.report_path);
  const bugId = String(input.bug_id);
  const item = report.items.find(
    (candidate) => String(candidate.bug.id) === bugId,
  );
  if (!item) throw new Error(`分诊报告中找不到 Bug：${bugId}`);
  const attachment = findBugAttachment(item, input.attachment_id);
  const ensureToken = options.ensureToken || ensureZentaoToken;
  const withTokenRefresh =
    options.withTokenRefresh ||
    (config.source.type === "zentao-v1"
      ? withAutomaticTokenRefresh
      : async (_config, operation) => ({
          value: await operation(),
          tokenAutoRefreshed: false,
        }));
  if (config.source.type === "zentao-v1") await ensureToken(config);
  const downloaded = await withTokenRefresh(
    config,
    () => downloadBugImage(config, bugId, attachment, options),
    options.authOptions,
  );
  return {
    configPath,
    reportPath: input.report_path,
    tokenAutoRefreshed: downloaded.tokenAutoRefreshed,
    ...downloaded.value,
  };
}

export async function selectWorkspaceForBug(input) {
  if (input.confirmed !== true) {
    throw new Error("只有用户已用自然语言明确授权修改后，才能选择修改工作目录");
  }
  const { config } = await resolveConfig(input.config_path);
  return selectCurrentWorkspace(config, input.report_path, input.bug_id, {
    confirmed: true,
    authorizationBasis: input.authorization_basis,
  });
}

export function createOneClickRepairServer() {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      instructions:
        "先用 zentao_list_my_bugs 的 summary 模式拉取分页摘要，再按 Bug ID 调用 zentao_get_bug_detail 从本地报告读取完整信息；只有截图影响判断时才读取图片附件。逐条语义分析后，用 bug_record_analyses 批量持久化，再展示可直接修改、等待确认、人工处理、详情失败和仓库待配置清单。详情失败项保持 BLOCKED，可按 Bug 单独 refresh 重试。用户可直接在聊天中纠正仓库、问题类型和确认状态；调用 bug_apply_user_supplement 在本地刷新现有报告，不要求回写禅道，也不重新拉取。用户提供仓库路径后，调用 repository_set_by_project 并传入本次 report_path。用户看过预览后，只要针对具体 Bug 明确确认修改，或直接提出具体修改方案，就已经完成授权；立即调用 workspace_select_for_bug，按情况传入 explicit-confirmation 或 user-provided-solution，绝不能再次索要确认。NEED_CONFIRM 和 HUMAN_REQUIRED 是默认分诊建议，不是用户授权后的死门禁；只有 BLOCKED 仍禁止修改。不得显示账号、密码或 Token，不操作 Git，不运行目标项目脚本。",
    },
  );

  server.registerTool(
    "zentao_auth_status",
    {
      title: "检查禅道初始化状态",
      description:
        "检查 One-Click-Repair 的本地配置、账号和 Token 是否就绪，不返回任何凭据内容。",
      inputSchema: optionalConfigPathSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      toolResult(
        await getZentaoAuthStatus(input),
        "已检查本地禅道初始化状态。",
      ),
  );

  server.registerTool(
    "zentao_list_my_bugs",
    {
      title: "拉取并预分诊我的禅道 Bug",
      description:
        "拉取禅道中指派给当前用户的未关闭 Bug，补充详情、仓库映射和规则预分诊，并生成本地报告。语义分类仍由 Codex逐条完成。",
      inputSchema: {
        response_mode: z
          .enum(["full", "summary"])
          .optional()
          .describe("返回完整条目或分页摘要；默认 full 兼容旧调用"),
        cursor: z
          .string()
          .regex(/^\d+$/u)
          .optional()
          .describe("summary 模式的零基偏移游标"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("summary 模式每页数量，默认 50，最大 100"),
        ...optionalConfigPathSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (input, extra) => {
      const onProgress = (message) => {
        void Promise.resolve(
          server.sendLoggingMessage(
            { level: "info", data: { stage: "zentao-list", message } },
            extra?.sessionId,
          ),
        ).catch(() => {});
      };
      const result = await listMyZentaoBugs(input, { onProgress });
      const elapsed = Number.isFinite(result.timings?.totalMs)
        ? `，耗时 ${(result.timings.totalMs / 1000).toFixed(2)} 秒`
        : "";
      return toolResult(
        result,
        result.responseMode === "summary"
          ? `已直接读取指派给我的 Bug 并生成预分诊报告${elapsed}；本页返回 ${result.items.length} 条摘要。`
          : `已直接读取指派给我的 Bug 并生成预分诊报告${elapsed}。`,
        { includeJson: result.responseMode !== "summary" },
      );
    },
  );

  server.registerTool(
    "zentao_get_bug_detail",
    {
      title: "获取单个禅道 Bug 详情",
      description:
        "根据 Bug ID 获取当前用户未关闭 Bug 的完整描述、步骤、评论、所属项目、执行和预分诊信息。",
      inputSchema: {
        bug_id: z.string().min(1).describe("禅道 Bug ID"),
        report_path: z
          .string()
          .min(1)
          .optional()
          .describe("可选的当前分诊报告路径；命中时直接读取本地报告"),
        refresh: z
          .boolean()
          .optional()
          .describe("是否忽略本地报告并只刷新该 Bug 的禅道详情"),
        ...optionalConfigPathSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (input) =>
      toolResult(
        await getZentaoBugDetail(input),
        `已获取 Bug ${input.bug_id} 的详情。`,
      ),
  );

  server.registerTool(
    "repository_get_by_project",
    {
      title: "查询代码仓库对应的本地目录",
      description:
        "按 Bug 中识别或用户补充的代码仓库名称查询本地仓库；精确匹配失败时会在结果唯一的前提下兼容简称。",
      inputSchema: {
        project_name: z.string().min(1).describe("Bug 中识别或用户补充的代码仓库名称"),
        ...optionalConfigPathSchema,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      toolResult(
        await getRepositoryByProject(input),
        `已查询代码仓库 ${input.project_name} 的本地目录映射。`,
      ),
  );

  server.registerTool(
    "repository_set_by_project",
    {
      title: "保存代码仓库对应的本地目录",
      description:
        "用户提供本地仓库目录后，按代码仓库名称验证并持久化该目录；传入现有 report_path 时会在本地重新分诊并返回刷新报告，不访问禅道。",
      inputSchema: {
        project_name: z.string().min(1).describe("代码仓库名称或用户使用的仓库简称"),
        repository_path: z.string().min(1).describe("用户提供的本地仓库绝对路径"),
        report_path: z
          .string()
          .min(1)
          .optional()
          .describe(
            "zentao_list_my_bugs 返回的报告绝对路径；提供后仅在本地刷新仓库状态和预分诊",
          ),
        ...optionalConfigPathSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      toolResult(
        await setRepositoryByProject(input),
        `已保存代码仓库 ${input.project_name} 的本地目录映射，并按需在本地刷新分诊报告。`,
      ),
  );

  server.registerTool(
    "bug_apply_user_supplement",
    {
      title: "应用用户对 Bug 分析的补充",
      description:
        "将用户在聊天中补充或纠正的代码仓库、问题类型、是否仍需确认和说明写入本地分诊报告，并立即在本地重新分诊；不要求回写禅道，也不访问禅道。",
      inputSchema: {
        bug_id: z.string().min(1).describe("需要补充或纠正的 Bug ID"),
        report_path: z.string().min(1).describe("本次分诊报告的绝对路径"),
        repository_project: z
          .string()
          .min(1)
          .optional()
          .describe("用户补充或纠正的代码仓库名称，可使用已保存仓库的唯一简称"),
        problem_type: z
          .enum(["逻辑", "样式", "需求"])
          .optional()
          .describe("用户补充或纠正的问题类型"),
        needs_confirmation: z
          .boolean()
          .optional()
          .describe("用户补充后，该 Bug 是否仍存在会改变实现方向的确认点"),
        note: z
          .string()
          .min(1)
          .optional()
          .describe("用户补充的实现要求、确认答案或纠正说明"),
        ...optionalConfigPathSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      toolResult(
        await applyBugUserSupplement(input),
        `已应用 Bug ${input.bug_id} 的聊天补充，并在本地刷新分诊结果。`,
      ),
  );

  server.registerTool(
    "bug_record_analyses",
    {
      title: "持久化 Codex 对 Bug 的语义分析",
      description:
        "将 Codex 逐条形成的核心问题、用户类型、确认点、证据、建议修改和风险批量写入当前本地报告；不访问或回写禅道。",
      inputSchema: {
        report_path: z.string().min(1).describe("当前分诊报告的绝对路径"),
        analyses: z
          .array(
            z.object({
              bug_id: z.string().min(1).describe("Bug ID"),
              summary: z.string().min(1).max(1000).describe("核心问题摘要"),
              problem_type: z.enum(["逻辑", "样式", "需求"]),
              subtype: z.string().min(1).max(100).optional(),
              needs_confirmation: z.boolean(),
              confirmation_question: z.string().min(1).max(1000).optional(),
              evidence: z.array(z.string().min(1).max(500)).max(10),
              proposed_change: z.string().min(1).max(2000).optional(),
              risk: z.enum(["low", "medium", "high"]),
            }),
          )
          .min(1)
          .max(50),
        ...optionalConfigPathSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      toolResult(
        await recordBugAnalyses(input),
        `已将 ${input.analyses.length} 条 Codex 语义分析写入本地报告。`,
        { includeJson: false },
      ),
  );

  server.registerTool(
    "zentao_get_bug_attachment",
    {
      title: "读取禅道 Bug 图片附件",
      description:
        "只读取当前报告中已声明且与禅道同源的 PNG、JPEG、WebP 或 GIF 图片附件，不落盘。",
      inputSchema: {
        bug_id: z.string().min(1).describe("Bug ID"),
        attachment_id: z.string().min(1).describe("Bug 详情中的附件 ID"),
        report_path: z.string().min(1).describe("当前分诊报告的绝对路径"),
        ...optionalConfigPathSchema,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      const result = await getZentaoBugAttachment(input);
      return {
        structuredContent: {
          configPath: result.configPath,
          reportPath: result.reportPath,
          tokenAutoRefreshed: result.tokenAutoRefreshed,
          ...result.metadata,
        },
        content: [
          {
            type: "text",
            text: `已读取 Bug ${result.metadata.bugId} 的图片附件 ${result.metadata.name}。`,
          },
          {
            type: "image",
            data: result.data,
            mimeType: result.metadata.mimeType,
          },
        ],
      };
    },
  );

  server.registerTool(
    "workspace_select_for_bug",
    {
      title: "授权后选择 Bug 修改目录",
      description:
        "用户看过预览后，只要针对具体 Bug 明确确认修改，或直接提出具体修改方案，就视为已经授权。AUTO_FIX、NEED_CONFIRM、HUMAN_REQUIRED 均可在授权后返回本地工作目录；BLOCKED 仍不可绕过。本工具不修改代码。",
      inputSchema: {
        bug_id: z.string().min(1).describe("本次最终清单中的 Bug ID"),
        report_path: z.string().min(1).describe("zentao_list_my_bugs 返回的报告绝对路径"),
        confirmed: z.literal(true).describe("用户是否已通过确认或具体修改方案明确授权"),
        authorization_basis: z
          .enum(["explicit-confirmation", "user-provided-solution"])
          .describe("授权依据：用户明确要求修改，或用户直接给出了具体修改方案"),
        ...optionalConfigPathSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      toolResult(
        await selectWorkspaceForBug(input),
        `已确认 Bug ${input.bug_id} 的本地修改目录。`,
      ),
  );

  return server;
}

export async function startServer() {
  const server = createOneClickRepairServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("One-Click-Repair MCP Server 已通过 stdio 启动");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  startServer().catch((error) => {
    console.error(`One-Click-Repair MCP Server 启动失败：${error.message}`);
    process.exitCode = 1;
  });
}
