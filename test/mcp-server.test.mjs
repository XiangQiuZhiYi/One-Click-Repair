import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  applyBugUserSupplement,
  createOneClickRepairServer,
  getRepositoryByProject,
  getZentaoAuthStatus,
  getZentaoBugAttachment,
  getZentaoBugDetail,
  listMyZentaoBugs,
  recordBugAnalyses,
  selectWorkspaceForBug,
  setRepositoryByProject,
} from "../plugins/one-click-repair/scripts/mcp-server.mjs";

const configPath = path.resolve("test/fixtures/forward-test.config.json");

test("MCP 服务声明完整的只读拉取和仓库映射工具", async () => {
  const server = createOneClickRepairServer();
  const client = new Client({
    name: "one-click-repair-test",
    version: "1.0.0",
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const response = await client.listTools();
    assert.deepEqual(
      response.tools.map((tool) => tool.name).sort(),
      [
        "bug_apply_user_supplement",
        "bug_record_analyses",
        "repository_get_by_project",
        "repository_set_by_project",
        "workspace_select_for_bug",
        "zentao_auth_status",
        "zentao_get_bug_attachment",
        "zentao_get_bug_detail",
        "zentao_list_my_bugs",
      ],
    );
  } finally {
    await client.close();
  }
});

test("用户可在聊天中补充仓库和确认状态并本地刷新报告", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "one-click-repair-user-supplement-"),
  );
  try {
    const configFile = path.join(directory, "config.json");
    const fixtureFile = path.join(directory, "bugs.json");
    const repositoryPath = path.join(directory, "example-react");
    await mkdir(repositoryPath);
    await writeFile(path.join(repositoryPath, "package.json"), "{}\n");
    await writeFile(
      fixtureFile,
      JSON.stringify([
        {
          id: "90001",
          title: "教师姓名分隔符显示错误",
          description: "详情标题当前多显示分隔符，预期只显示实际存在的名称。",
          steps: "进入课时统计页面并打开教师详情。",
          status: "active",
          assignee: "me",
          severity: 3,
        },
      ]),
    );
    await writeFile(
      configFile,
      JSON.stringify({
        currentUser: "me",
        source: { type: "fixture", path: "./bugs.json" },
        outputDir: "./output",
        repositoriesByProject: {
          "example-react": repositoryPath,
        },
      }),
    );

    const initial = await listMyZentaoBugs({ config_path: configFile });
    assert.equal(initial.items[0].triage.decision, "BLOCKED");
    const updated = await applyBugUserSupplement({
      config_path: configFile,
      report_path: initial.reportPath,
      bug_id: "90001",
      repository_project: "react",
      problem_type: "逻辑",
      needs_confirmation: false,
      note: "英文名为空时不显示分隔符。",
    });

    assert.equal(updated.zentaoRequested, false);
    assert.equal(updated.item.bug.repositoryProject, "react");
    assert.equal(updated.item.bug.repositoryProjectSource, "chat");
    assert.equal(updated.item.repository.projectKey, "example-react");
    assert.equal(updated.item.repository.matchType, "fuzzy");
    assert.equal(updated.item.triage.decision, "AUTO_FIX");

    const selected = await selectWorkspaceForBug({
      config_path: configFile,
      bug_id: "90001",
      report_path: initial.reportPath,
      confirmed: true,
      authorization_basis: "user-provided-solution",
    });
    assert.equal(selected.metadata.workspacePath, repositoryPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP 认证状态不会返回账号、密码或 Token 内容", async () => {
  const status = await getZentaoAuthStatus({
    config_path: configPath,
  });
  assert.equal(status.configured, true);
  assert.equal(status.accountReady, true);
  assert.equal(status.tokenReady, true);
  assert.equal("password" in status, false);
  assert.equal("token" in status, false);
});

test("MCP 能使用 Fixture 拉取并查询单个 Bug", async () => {
  const result = await listMyZentaoBugs({
    config_path: configPath,
  });
  assert.equal(result.stats.total, 3);
  assert.equal(result.items.length, 3);
  assert.equal(result.requestSummary.listMode, "fixture");
  assert.equal(result.timings.totalMs, 0);
  assert.equal(path.isAbsolute(result.reportPath), true);

  const detail = await getZentaoBugDetail({
    config_path: configPath,
    bug_id: "101",
  });
  assert.equal(detail.item.bug.id, "101");
  assert.equal(detail.item.repositoryKey, "example-frontend");
  assert.equal(detail.item.bug.repositoryProject, "example-frontend");
  assert.equal(detail.item.bug.affectedVersion, "1.2.0");
});

test("没有现有报告时单 Bug 查询创建明确标记的单项报告", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "one-click-repair-single-report-"));
  try {
    const configFile = path.join(directory, "config.json");
    const fixtureFile = path.join(directory, "bugs.json");
    await writeFile(
      fixtureFile,
      JSON.stringify([
        {
          id: "601",
          title: "单项详情",
          description: "按钮当前显示错误，预期显示正确。",
          steps: "打开页面查看按钮。",
          status: "active",
          assignee: "me",
        },
        {
          id: "602",
          title: "其他人的 Bug",
          description: "不应读取。",
          steps: "打开页面。",
          status: "active",
          assignee: "other",
        },
        {
          id: "603",
          title: "缺少指派人",
          description: "详情没有指派人时不能进入修改流程。",
          steps: "打开页面。",
          status: "active",
        },
      ]),
    );
    await writeFile(
      configFile,
      JSON.stringify({
        currentUser: "me",
        source: { type: "fixture", path: "./bugs.json" },
        outputDir: "./output",
      }),
    );
    const result = await getZentaoBugDetail({
      config_path: configFile,
      bug_id: "601",
    });
    assert.equal(result.zentaoRequested, true);
    const report = JSON.parse(await readFile(result.reportPath, "utf8"));
    assert.equal(report.scope, "single-bug");
    assert.equal(report.completeList, false);
    assert.equal(report.items.length, 1);
    await applyBugUserSupplement({
      config_path: configFile,
      report_path: result.reportPath,
      bug_id: "601",
      problem_type: "逻辑",
      needs_confirmation: false,
    });
    const supplementedReport = JSON.parse(await readFile(result.reportPath, "utf8"));
    assert.equal(supplementedReport.scope, "single-bug");
    assert.equal(supplementedReport.completeList, false);
    await assert.rejects(
      getZentaoBugDetail({ config_path: configFile, bug_id: "602", refresh: true }),
      /已关闭、未指派给当前账号或不存在/,
    );
    await assert.rejects(
      getZentaoBugDetail({ config_path: configFile, bug_id: "603", refresh: true }),
      /已关闭、未指派给当前账号或不存在/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("summary 模式分页返回精简条目且不包含完整描述", async () => {
  const result = await listMyZentaoBugs({
    config_path: configPath,
    response_mode: "summary",
    cursor: "0",
    limit: 1,
  });
  assert.equal(result.responseMode, "summary");
  assert.equal(result.items.length, 1);
  assert.equal(result.nextCursor, "1");
  assert.equal("description" in result.items[0], false);
  assert.equal("comments" in result.items[0], false);
  assert.equal(typeof result.items[0].attachmentCount, "number");
  const next = await listMyZentaoBugs({
    config_path: configPath,
    response_mode: "summary",
    cursor: result.nextCursor,
    limit: 1,
  });
  assert.equal(next.zentaoRequested, false);
  assert.equal(next.cursor, "1");
});

test("Codex 语义分析批量持久化且用户补充优先", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "one-click-repair-ai-analysis-"));
  try {
    const configFile = path.join(directory, "config.json");
    const fixtureFile = path.join(directory, "bugs.json");
    const repositoryPath = path.join(directory, "example-react");
    await mkdir(repositoryPath);
    await writeFile(path.join(repositoryPath, "package.json"), "{}\n");
    await writeFile(
      fixtureFile,
      JSON.stringify([
        {
          id: "701",
          title: "页面行为异常",
          description: "页面当前行为与预期不一致，需要确认后调整。",
          steps: "打开页面并执行操作。",
          status: "active",
          assignee: "me",
          severity: 3,
          comments: [{ comment: "<p>所属项目：example-react</p>" }],
        },
      ]),
    );
    await writeFile(
      configFile,
      JSON.stringify({
        currentUser: "me",
        source: { type: "fixture", path: "./bugs.json" },
        outputDir: "./output",
        repositoriesByProject: { "example-react": repositoryPath },
      }),
    );
    const initial = await listMyZentaoBugs({ config_path: configFile });
    const recorded = await recordBugAnalyses({
      config_path: configFile,
      report_path: initial.reportPath,
      analyses: [
        {
          bug_id: "701",
          summary: "筛选条件切换后没有刷新结果",
          problem_type: "逻辑",
          subtype: "状态同步",
          needs_confirmation: true,
          confirmation_question: "切换后是否应立即请求接口？",
          evidence: ["描述提到行为与预期不一致"],
          proposed_change: "在筛选条件变化时刷新数据",
          risk: "medium",
        },
      ],
    });
    assert.equal(recorded.count, 1);
    assert.equal(recorded.results[0].decision, "NEED_CONFIRM");
    const persisted = JSON.parse(await readFile(initial.reportPath, "utf8"));
    assert.equal(persisted.items[0].aiAnalysis.problemType, "逻辑");

    const supplemented = await applyBugUserSupplement({
      config_path: configFile,
      report_path: initial.reportPath,
      bug_id: "701",
      problem_type: "样式",
      needs_confirmation: false,
      note: "用户确认只调整展示样式。",
    });
    assert.equal(supplemented.item.triage.category, "STYLE");
    assert.equal(supplemented.item.triage.decision, "AUTO_FIX");
    assert.equal(supplemented.item.aiAnalysis.problemType, "逻辑");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("读取同源图片附件且不把 base64 放入结构化元数据", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "one-click-repair-image-"));
  try {
    const configFile = path.join(directory, "config.json");
    const outputDir = path.join(directory, "output");
    const reportPath = path.join(outputDir, "triage.json");
    await mkdir(outputDir, { recursive: true });
    await writeFile(
      configFile,
      JSON.stringify({
        currentUser: "me",
        source: {
          type: "rest",
          baseUrl: "https://zentao.example.com/zentao",
          urlTemplate: "{baseUrl}/bugs?page={page}",
          responseItemsPath: "data.bugs",
        },
        outputDir: "./output",
      }),
    );
    await writeFile(
      reportPath,
      JSON.stringify({
        schemaVersion: 2,
        items: [
          {
            bug: {
              id: "801",
              attachments: [
                {
                  id: "9",
                  name: "screen.png",
                  mimeType: "image/png",
                  url: "/zentao/files/screen.png",
                },
              ],
            },
          },
        ],
      }),
    );
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const result = await getZentaoBugAttachment(
      {
        config_path: configFile,
        report_path: reportPath,
        bug_id: "801",
        attachment_id: "9",
      },
      {
        fetchImplementation: async () =>
          new Response(png, {
            headers: {
              "Content-Type": "image/png",
              "Content-Length": String(png.length),
            },
          }),
      },
    );
    assert.equal(result.metadata.mimeType, "image/png");
    assert.equal(result.data, png.toString("base64"));
    assert.equal("data" in result.metadata, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP 按评论中的所属项目读取已保存仓库映射", async () => {
  const result = await getRepositoryByProject({
    config_path: configPath,
    project_name: "Example-Frontend",
  });
  assert.equal(result.found, true);
  assert.equal(result.projectKey, "example-frontend");
  assert.equal(result.repository.available, true);
  assert.equal(path.isAbsolute(result.repository.repoPath), true);
});

test("保存仓库映射后只基于现有报告本地刷新，不重新读取 Bug 数据源", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "one-click-repair-local-refresh-"),
  );
  try {
    const configFile = path.join(directory, "config.json");
    const fixtureFile = path.join(directory, "bugs.json");
    const repositoryPath = path.join(directory, "example-react");
    await mkdir(repositoryPath);
    await writeFile(path.join(repositoryPath, "package.json"), "{}\n");
    await writeFile(
      fixtureFile,
      JSON.stringify([
        {
          id: "501",
          title: "按钮文案拼写错误",
          description: "提交按钮当前显示为“保 存存”，预期应显示为“保存”。",
          steps: "打开编辑页面即可看到该错误文案。",
          status: "active",
          assignee: "me",
          severity: 3,
          comments: [
            {
              comment:
                "<p>所属项目：example-react</p><p>状态：直接处理</p>",
            },
          ],
        },
      ]),
    );
    await writeFile(
      configFile,
      JSON.stringify({
        currentUser: "me",
        source: { type: "fixture", path: "./bugs.json" },
        outputDir: "./output",
        repositoriesByProject: {},
      }),
    );

    const initial = await listMyZentaoBugs({ config_path: configFile });
    assert.equal(initial.items[0].triage.decision, "BLOCKED");

    await rm(fixtureFile);
    const saved = await setRepositoryByProject({
      config_path: configFile,
      project_name: "example-react",
      repository_path: repositoryPath,
      report_path: initial.reportPath,
    });

    assert.equal(saved.saved, true);
    assert.equal(saved.reportRefresh.refreshed, true);
    assert.equal(saved.reportRefresh.source, "local-report");
    assert.equal(saved.reportRefresh.zentaoRequested, false);
    assert.equal(saved.reportRefresh.items[0].triage.decision, "AUTO_FIX");
    assert.equal(
      saved.reportRefresh.items[0].repository.repoPath,
      repositoryPath,
    );
    const refreshedReport = JSON.parse(
      await readFile(initial.reportPath, "utf8"),
    );
    assert.equal(refreshedReport.items[0].triage.decision, "AUTO_FIX");
    assert.equal(refreshedReport.items[0].repository.repoPath, repositoryPath);

    const selected = await selectWorkspaceForBug({
      config_path: configFile,
      bug_id: "501",
      report_path: initial.reportPath,
      confirmed: true,
      authorization_basis: "explicit-confirmation",
    });
    assert.equal(selected.metadata.workspacePath, repositoryPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
