import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../plugins/one-click-repair/skills/zentao-frontend-bugfix/scripts/lib/config.mjs";
import {
  extractRepositoryProject,
  normalizeBug,
} from "../plugins/one-click-repair/skills/zentao-frontend-bugfix/scripts/lib/normalize.mjs";
import { findRepository } from "../plugins/one-click-repair/skills/zentao-frontend-bugfix/scripts/lib/repository.mjs";
import { writeTriageReport } from "../plugins/one-click-repair/skills/zentao-frontend-bugfix/scripts/lib/report.mjs";
import { triageBugs } from "../plugins/one-click-repair/skills/zentao-frontend-bugfix/scripts/lib/triage.mjs";

test("所属项目解析兼容旧写法并以最新评论为准", () => {
  assert.equal(
    extractRepositoryProject([
      { comment: "<p>属于项目：sisvue</p>" },
      { comment: "<p>所属项目：sisreact</p>" },
    ]),
    "sisreact",
  );
});

test("从问题描述中的问题代码仓库字段识别仓库", () => {
  const bug = normalizeBug({
    id: "47636",
    title: "教师姓名显示分隔符",
    description:
      "当前结果与期望结果不一致。\n问题代码仓库：sisreact\n代码分析：详情标题模板需要调整。",
    steps: "进入课时统计页面查看教师详情。",
  });
  assert.equal(bug.repositoryProject, "sisreact");
  assert.equal(bug.repositoryProjectSource, "description");
  assert.equal(bug.repositoryProjectLabel, "问题代码仓库");
});

test("评论中的仓库字段优先于描述中的仓库字段", () => {
  const bug = normalizeBug({
    id: "47637",
    description: "问题代码仓库：sisvue",
    comments: [{ comment: "<p>代码仓库：sisreact</p>" }],
  });
  assert.equal(bug.repositoryProject, "sisreact");
  assert.equal(bug.repositoryProjectSource, "comment");
});

test("仓库简称只有唯一匹配时才自动复用", () => {
  const unique = findRepository(
    { repositoryProject: "react" },
    {
      sisreact: { name: "sisreact", repoPath: "/workspace/sisreact" },
      sisvue: { name: "sisvue", repoPath: "/workspace/sisvue" },
    },
  );
  assert.equal(unique.projectKey, "sisreact");
  assert.equal(unique.matchType, "fuzzy");

  const ambiguous = findRepository(
    { repositoryProject: "react" },
    {
      sisreact: { name: "sisreact", repoPath: "/workspace/sisreact" },
      adminreact: { name: "adminreact", repoPath: "/workspace/adminreact" },
    },
  );
  assert.equal(ambiguous, undefined);
});

test("离线数据可以完成跨结论分诊并生成报告", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bugfix-triage-"));
  try {
    const fixturePath = path.join(directory, "bugs.json");
    const configPath = path.join(directory, "config.json");
    const repoPath = path.join(directory, "repo");
    await mkdir(repoPath);
    await writeFile(path.join(repoPath, "package.json"), "{}\n");
    await writeFile(
      fixturePath,
      JSON.stringify([
        {
          id: "101",
          title: "按钮文案拼写错误",
          description: "提交按钮现在显示为“保 存存”，预期应显示为“保存”。",
          steps: "进入编辑页面即可看到错误文案。",
          product: "A",
          project: "Web",
          execution: 100,
          executionName: "Web 迭代",
          module: "表单",
          status: "active",
          assignee: "me",
          severity: 3,
          comments: [{ comment: "<p>所属项目：web-react</p>" }],
        },
        {
          id: "102",
          title: "未知项目页面异常",
          description: "打开页面后内容显示异常，请帮助处理。",
          steps: "进入页面后可以看到。",
          product: "B",
          project: "Other",
          execution: 200,
          executionName: "其他迭代",
          module: "列表",
          status: "active",
          assignee: "me",
          severity: 3,
          comments: [{ comment: "<p>所属项目：other-vue</p>" }],
        },
        {
          id: "103",
          title: "已经关闭",
          description: "不应进入报告。",
          product: "A",
          project: "Web",
          status: "closed",
          assignee: "me",
        },
      ]),
    );
    await writeFile(
      configPath,
      JSON.stringify({
        currentUser: "me",
        source: { type: "fixture", path: "./bugs.json" },
        outputDir: "./output",
        repositoriesByProject: {
          "web-react": repoPath,
        },
      }),
    );

    const config = await loadConfig(configPath);
    const items = await triageBugs(config);
    assert.equal(items.length, 2);
    assert.equal(items[0].triage.decision, "AUTO_FIX");
    assert.equal(items[0].bug.repositoryProject, "web-react");
    assert.equal(items[0].repositoryKey, "web-react");
    assert.equal(items[0].repository.projectKey, "web-react");
    assert.equal(items[1].triage.decision, "BLOCKED");
    assert.equal(items[1].repositoryKey, "other-vue");

    const output = await writeTriageReport(config, items);
    assert.equal(output.report.stats.byDecision.AUTO_FIX, 1);
    assert.equal(output.report.stats.byDecision.BLOCKED, 1);
    assert.match(await readFile(output.markdownPath, "utf8"), /Bug 总数：2/);
    assert.match(await readFile(output.markdownPath, "utf8"), /可直接修改（等待用户确认修改）/);
    assert.match(await readFile(output.markdownPath, "utf8"), /仓库或环境待配置/);
    assert.match(await readFile(output.markdownPath, "utf8"), /web-react/);
    assert.match(await readFile(output.markdownPath, "utf8"), /Web 迭代/);
    assert.match(await readFile(path.join(config.outputDir, "bugs", "101.md"), "utf8"), /AUTO_FIX/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("同一所属执行下根据评论中的不同项目选择不同仓库", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bugfix-project-mapping-"));
  try {
    const fixturePath = path.join(directory, "bugs.json");
    const configPath = path.join(directory, "config.json");
    const reactRepo = path.join(directory, "sisreact");
    const vueRepo = path.join(directory, "sisvue");
    await mkdir(reactRepo);
    await mkdir(vueRepo);
    await writeFile(
      fixturePath,
      JSON.stringify([
        {
          id: "201",
          title: "React 页面文案错误",
          description: "页面当前显示错误文案，预期显示正确文案。",
          steps: "打开页面即可看到。",
          execution: 2640,
          executionName: "课时统计翻新",
          status: "active",
          assignee: "me",
          severity: 3,
          comments: [{ comment: "<p>所属项目：sisreact</p>" }],
        },
        {
          id: "202",
          title: "Vue 页面文案错误",
          description: "页面当前显示错误文案，预期显示正确文案。",
          steps: "打开页面即可看到。",
          execution: 2640,
          executionName: "课时统计翻新",
          status: "active",
          assignee: "me",
          severity: 3,
          comments: [{ comment: "<p>所属项目：sisvue</p>" }],
        },
      ]),
    );
    await writeFile(
      configPath,
      JSON.stringify({
        currentUser: "me",
        source: { type: "fixture", path: "./bugs.json" },
        repositoriesByProject: {
          sisreact: reactRepo,
          sisvue: vueRepo,
        },
      }),
    );

    const config = await loadConfig(configPath);
    const items = await triageBugs(config);
    assert.equal(items[0].repository.repoPath, reactRepo);
    assert.equal(items[1].repository.repoPath, vueRepo);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("缺少代码仓库线索时不会回退到所属执行仓库", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bugfix-project-required-"));
  try {
    const fixturePath = path.join(directory, "bugs.json");
    const configPath = path.join(directory, "config.json");
    await writeFile(
      fixturePath,
      JSON.stringify([
        {
          id: "301",
          title: "按钮文案错误",
          description: "按钮当前显示错误文案，预期显示保存。",
          steps: "打开页面即可看到。",
          execution: 2640,
          executionName: "课时统计翻新",
          status: "active",
          assignee: "me",
          severity: 3,
        },
      ]),
    );
    await writeFile(
      configPath,
      JSON.stringify({
        currentUser: "me",
        source: { type: "fixture", path: "./bugs.json" },
        repositoriesByExecution: { "2640": directory },
      }),
    );

    const config = await loadConfig(configPath);
    const [item] = await triageBugs(config);
    assert.equal(item.repositoryKey, "");
    assert.equal(item.repository, undefined);
    assert.equal(item.triage.decision, "BLOCKED");
    assert.match(item.triage.questions.join("\n"), /直接在聊天中说明/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
