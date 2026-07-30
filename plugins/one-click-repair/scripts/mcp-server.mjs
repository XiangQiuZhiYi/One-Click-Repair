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
const SERVER_VERSION = "0.6.0";

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
        : "尚未初始化账号，请在 One-Click-Repair 项目中运行 npm run bootstrap。",
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
  const mapping = config.repositoriesByProject[projectKey];
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
    projectKey,
    projectName,
  });
  return {
    found: true,
    projectKey,
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
    const expectedReportPath = path.resolve(currentConfig.outputDir, "triage.json");
    requestedReportPath = path.resolve(input.report_path);
    if (requestedReportPath !== expectedReportPath) {
      throw new Error(
        `report_path 必须是本次配置生成的分诊报告：${expectedReportPath}`,
      );
    }
    existingReport = await readJson(requestedReportPath);
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

export async function selectWorkspaceForBug(input) {
  if (input.confirmed !== true) {
    throw new Error("只有用户明确回复“确认修改”后才能选择修改工作目录");
  }
  const { config } = await resolveConfig(input.config_path);
  return selectCurrentWorkspace(config, input.report_path, input.bug_id, {
    confirmed: true,
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
        "先调用 zentao_list_my_bugs 拉取并逐条语义分析 Bug，从评论中的“所属项目：XXX”识别前端项目并按项目映射本地仓库，再向用户展示可直接修改、等待确认、人工处理和仓库待配置清单。用户提供仓库后，调用 repository_set_by_project 时传入本次 report_path，直接使用其 reportRefresh 在本地刷新最终清单；不得仅因保存仓库映射而再次调用 zentao_list_my_bugs。任何 Bug 都不得因工具调用而直接改代码；只有用户在看到最终清单后明确回复“确认修改”，才可调用 workspace_select_for_bug 并由 Codex修改本地代码。不得显示账号、密码或 Token，不操作 Git，不运行目标项目脚本。",
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
      title: "查询所属项目对应的本地仓库",
      description:
        "按 Bug 评论中的“所属项目：XXX”查询已保存的本地前端仓库目录和当前可用状态。",
      inputSchema: {
        project_name: z.string().min(1).describe("Bug 评论中备注的所属项目名称"),
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
        `已查询所属项目 ${input.project_name} 的仓库映射。`,
      ),
  );

  server.registerTool(
    "repository_set_by_project",
    {
      title: "保存所属项目对应的本地仓库",
      description:
        "仅在用户提供本地仓库目录后，按 Bug 评论中的所属项目名称验证并持久化该目录；传入现有 report_path 时会在本地重新分诊并返回刷新报告，不访问禅道。",
      inputSchema: {
        project_name: z.string().min(1).describe("Bug 评论中备注的所属项目名称"),
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
        `已保存所属项目 ${input.project_name} 的仓库映射，并按需在本地刷新分诊报告。`,
      ),
  );

  server.registerTool(
    "workspace_select_for_bug",
    {
      title: "确认后选择 Bug 修改目录",
      description:
        "仅在用户已看到最终清单并明确回复“确认修改”后，校验报告中的 Bug 并返回其本地工作目录；本工具不修改代码。",
      inputSchema: {
        bug_id: z.string().min(1).describe("本次最终清单中的 Bug ID"),
        report_path: z.string().min(1).describe("zentao_list_my_bugs 返回的报告绝对路径"),
        confirmed: z.literal(true).describe("用户是否已明确回复“确认修改”"),
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
