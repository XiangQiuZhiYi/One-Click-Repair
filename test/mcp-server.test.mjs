import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  createOneClickRepairServer,
  getRepositoryByProject,
  getZentaoAuthStatus,
  getZentaoBugDetail,
  listMyZentaoBugs,
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
        "repository_get_by_project",
        "repository_set_by_project",
        "workspace_select_for_bug",
        "zentao_auth_status",
        "zentao_get_bug_detail",
        "zentao_list_my_bugs",
      ],
    );
  } finally {
    await client.close();
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
    const repositoryPath = path.join(directory, "sisreact");
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
                "<p>所属项目：sisreact</p><p>状态：直接处理</p>",
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
      project_name: "sisreact",
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
    });
    assert.equal(selected.metadata.workspacePath, repositoryPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
