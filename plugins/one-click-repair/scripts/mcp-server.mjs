#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

import {
  ensureZentaoToken,
  findStoredToken,
  withAutomaticTokenRefresh,
} from "../skills/zentao-frontend-bugfix/scripts/lib/auth.mjs";
import { findDefaultConfigPath } from "../skills/zentao-frontend-bugfix/scripts/lib/config-path.mjs";
import { loadConfig } from "../skills/zentao-frontend-bugfix/scripts/lib/config.mjs";
import { writeTriageReport } from "../skills/zentao-frontend-bugfix/scripts/lib/report.mjs";
import {
  findRepository,
  inspectRepository,
  repositoryKeyForProject,
} from "../skills/zentao-frontend-bugfix/scripts/lib/repository.mjs";
import { storeRepositoryByProject } from "../skills/zentao-frontend-bugfix/scripts/lib/repository-store.mjs";
import {
  retriageExistingItems,
  triageBugs,
} from "../skills/zentao-frontend-bugfix/scripts/lib/triage.mjs";
import { readJson } from "../skills/zentao-frontend-bugfix/scripts/lib/utils.mjs";
import { selectCurrentWorkspace } from "../skills/zentao-frontend-bugfix/scripts/lib/workspace.mjs";

const SERVER_NAME = "one-click-repair";
const SERVER_VERSION = "0.7.3";

const optionalConfigPathSchema = {
  config_path: z
    .string()
    .min(1)
    .optional()
    .describe("可选的禅道配置绝对路径；日常使用时不要传"),
};

function toolResult(data, message) {
  return {
    structuredContent: data,
    content: [
      {
        type: "text",
        text: `${message}\n${JSON.stringify(data, null, 2)}`,
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
    report: await readJson(requestedReportPath),
  };
}

async function collectTriage(config) {
  const token = await ensureZentaoToken(config);
  const triage = await withAutomaticTokenRefresh(config, () => triageBugs(config));
  const written = await writeTriageReport(config, triage.value);
  return {
    reportPath: written.jsonPath,
    summaryPath: written.markdownPath,
    stats: written.report.stats,
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

export async function listMyZentaoBugs(input = {}) {
  const { configPath, config } = await resolveConfig(input.config_path);
  return {
    configPath,
    ...(await collectTriage(config)),
  };
}

export async function getZentaoBugDetail(input) {
  const result = await listMyZentaoBugs(input);
  const item = result.items.find(
    (candidate) => String(candidate.bug.id) === String(input.bug_id),
  );
  if (!item) {
    throw new Error(`当前分配给你的未关闭 Bug 中不存在 ${input.bug_id}`);
  }
  return {
    reportPath: result.reportPath,
    summaryPath: result.summaryPath,
    item,
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
    const written = await writeTriageReport(config, items);
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
  const written = await writeTriageReport(config, items);
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
        "先调用 zentao_list_my_bugs 拉取并逐条语义分析 Bug，从评论、描述和复现步骤中的代码仓库线索识别前端项目，并按项目映射本地仓库，再向用户展示可直接修改、等待确认、人工处理和仓库待配置清单。用户可直接在聊天中纠正仓库、问题类型和确认状态；调用 bug_apply_user_supplement 在本地刷新现有报告，不要求回写禅道，也不重新拉取。用户提供仓库路径后，调用 repository_set_by_project 并传入本次 report_path。用户看过预览后，只要针对具体 Bug 明确确认修改，或直接提出具体修改方案，就已经完成授权；立即调用 workspace_select_for_bug，按情况传入 explicit-confirmation 或 user-provided-solution，绝不能再次索要确认。NEED_CONFIRM 和 HUMAN_REQUIRED 是默认分诊建议，不是用户授权后的死门禁；只有 BLOCKED 仍禁止修改。不得显示账号、密码或 Token，不操作 Git，不运行目标项目脚本。",
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
      inputSchema: optionalConfigPathSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (input) =>
      toolResult(
        await listMyZentaoBugs(input),
        "已拉取并生成禅道 Bug 预分诊报告。",
      ),
  );

  server.registerTool(
    "zentao_get_bug_detail",
    {
      title: "获取单个禅道 Bug 详情",
      description:
        "根据 Bug ID 获取当前用户未关闭 Bug 的完整描述、步骤、评论、所属项目、执行和预分诊信息。",
      inputSchema: {
        bug_id: z.string().min(1).describe("禅道 Bug ID"),
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
        readOnlyHint: true,
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
