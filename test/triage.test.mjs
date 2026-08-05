import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../plugins/one-click-repair/skills/zentao-frontend-bugfix/scripts/lib/config.mjs";
import {
  extractRepositoryProject,
  normalizeBug,
} from "../plugins/one-click-repair/skills/zentao-frontend-bugfix/scripts/lib/normalize.mjs";
import { findRepository } from "../plugins/one-click-repair/skills/zentao-frontend-bugfix/scripts/lib/repository.mjs";
import {
  readTriageReport,
  writeTriageReport,
} from "../plugins/one-click-repair/skills/zentao-frontend-bugfix/scripts/lib/report.mjs";
import { triageBugs } from "../plugins/one-click-repair/skills/zentao-frontend-bugfix/scripts/lib/triage.mjs";

test("所属项目解析兼容旧写法并以最新评论为准", () => {
  assert.equal(
    extractRepositoryProject([
      { comment: "<p>属于项目：example-vue</p>" },
      { comment: "<p>所属项目：example-react</p>" },
    ]),
    "example-react",
  );
});

test("从问题描述中的问题代码仓库字段识别仓库", () => {
  const bug = normalizeBug({
    id: "90001",
    title: "副标题为空时仍显示分隔符",
    description:
      "当前结果与期望结果不一致。\n问题代码仓库：example-react\n代码分析：详情标题模板需要调整。",
    steps: "进入详情页面查看标题。",
  });
  assert.equal(bug.repositoryProject, "example-react");
  assert.equal(bug.repositoryProjectSource, "description");
  assert.equal(bug.repositoryProjectLabel, "问题代码仓库");
});

test("评论中的仓库字段优先于描述中的仓库字段", () => {
  const bug = normalizeBug({
    id: "90002",
    description: "问题代码仓库：example-vue",
    comments: [{ comment: "<p>代码仓库：example-react</p>" }],
  });
  assert.equal(bug.repositoryProject, "example-react");
  assert.equal(bug.repositoryProjectSource, "comment");
});

test("禅道 files 的对象和数组形式统一为安全附件元数据", () => {
  const objectBug = normalizeBug({
    id: "attachment-object",
    files: {
      "9": {
        title: "screen.png",
        mimeType: "image/png",
        size: "123",
        webPath: "/files/9",
        privateField: "discarded",
      },
    },
  }, { attachments: "files" });
  assert.deepEqual(objectBug.attachments, [
    {
      id: "9",
      name: "screen.png",
      mimeType: "image/png",
      size: 123,
      webPath: "/files/9",
    },
  ]);
  const arrayBug = normalizeBug({
    id: "attachment-array",
    attachments: [{ id: 10, fileName: "shot.jpg", downloadUrl: "/files/10" }],
  });
  assert.equal(arrayBug.attachments[0].id, "10");
  assert.equal(arrayBug.attachments[0].name, "shot.jpg");
});

test("富文本内联图片在清除 HTML 前提取并与 files 附件去重", () => {
  const bug = normalizeBug({
    id: "inline-image",
    steps:
      '<p>操作结果</p><p><img src="http://zentao.example.com/zentao/file-read-12345.png" alt="result.png"></p>',
    description:
      '<img src="http://zentao.example.com/zentao/file-read-12345.png" alt="duplicate.png">',
    files: {
      "12345": {
        title: "official.png",
        size: 321,
      },
    },
  }, { attachments: "files" });

  assert.equal(bug.attachments.length, 1);
  assert.deepEqual(bug.attachments[0], {
    id: "12345",
    name: "official.png",
    mimeType: "image/png",
    size: 321,
    url: "http://zentao.example.com/zentao/file-read-12345.png",
    source: "inline-html",
  });
  assert.equal(bug.steps.includes("file-read"), false);
});

test("相对内联图片生成稳定附件 ID、路径和类型", () => {
  const first = normalizeBug({
    id: "relative-inline-image",
    steps: '<img src="/zentao/files/result.webp?download=1" alt="result.webp">',
  });
  const second = normalizeBug({
    id: "relative-inline-image",
    steps: '<img src="/zentao/files/result.webp?download=1" alt="result.webp">',
  });
  assert.equal(first.attachments.length, 1);
  assert.equal(first.attachments[0].id, second.attachments[0].id);
  assert.match(first.attachments[0].id, /^inline-[a-f0-9]{12}$/u);
  assert.equal(first.attachments[0].webPath, "/zentao/files/result.webp?download=1");
  assert.equal(first.attachments[0].mimeType, "image/webp");

  const bareRelative = normalizeBug({
    id: "bare-relative-inline-image",
    steps: '<img src="file-read-77.png">',
  }, {}, { baseUrl: "https://zentao.example.com/zentao" });
  assert.equal(bareRelative.attachments[0].webPath, "/zentao/file-read-77.png");

  const externalProtocolRelative = normalizeBug({
    id: "external-protocol-relative-image",
    steps: '<img src="//evil.example/screen.png">',
  }, {}, { baseUrl: "https://zentao.example.com/zentao" });
  assert.equal(externalProtocolRelative.attachments[0].url, "//evil.example/screen.png");
});

test("仓库简称只有唯一匹配时才自动复用", () => {
  const unique = findRepository(
    { repositoryProject: "react" },
    {
      "example-react": { name: "example-react", repoPath: "/workspace/example-react" },
      "example-vue": { name: "example-vue", repoPath: "/workspace/example-vue" },
    },
  );
  assert.equal(unique.projectKey, "example-react");
  assert.equal(unique.matchType, "fuzzy");

  const ambiguous = findRepository(
    { repositoryProject: "react" },
    {
      "example-react": { name: "example-react", repoPath: "/workspace/example-react" },
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
    assert.equal(output.report.requestSummary.listMode, "fixture");
    assert.equal(output.report.requestSummary.matchedBugCount, 2);
    assert.equal(output.report.timings.totalMs, 0);
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

test("报告使用私有权限原子写入并清理已不在当前清单的 Bug 明细", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bugfix-private-report-"));
  try {
    const outputDir = path.join(directory, "output");
    const config = { currentUser: "me", outputDir };
    const makeItem = (id) => ({
      bug: { id, title: `Bug ${id}`, attachments: [], comments: [], fetchStatus: "complete" },
      triage: {
        category: "COPY",
        decision: "AUTO_FIX",
        confidence: 0.9,
        reasons: ["test"],
        questions: [],
        nextAction: "test",
      },
    });
    await writeTriageReport(config, [makeItem("101"), makeItem("102")]);
    await chmod(path.join(outputDir, "triage.json"), 0o644);
    const upgraded = await readTriageReport(path.join(outputDir, "triage.json"));
    assert.equal(upgraded.schemaVersion, 2);
    assert.equal((await stat(outputDir)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(outputDir, "triage.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(outputDir, "triage.md"))).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(outputDir, "bugs"))).mode & 0o777, 0o700);

    await writeTriageReport(config, [makeItem("101")]);
    await assert.rejects(readFile(path.join(outputDir, "bugs", "102.md")), {
      code: "ENOENT",
    });
    assert.match(await readFile(path.join(outputDir, "bugs", "101.md"), "utf8"), /Bug 101/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("读取 schemaVersion 1 报告时在内存中升级且不丢失条目", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bugfix-report-v1-"));
  try {
    const reportPath = path.join(directory, "triage.json");
    await writeFile(reportPath, JSON.stringify({ schemaVersion: 1, items: [{ bug: { id: "1" } }] }));
    const report = await readTriageReport(reportPath);
    assert.equal(report.schemaVersion, 2);
    assert.equal(report.completeList, true);
    assert.equal(report.items[0].bug.id, "1");
    assert.equal((await stat(reportPath)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("同一所属执行下根据评论中的不同项目选择不同仓库", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bugfix-project-mapping-"));
  try {
    const fixturePath = path.join(directory, "bugs.json");
    const configPath = path.join(directory, "config.json");
    const reactRepo = path.join(directory, "example-react");
    const vueRepo = path.join(directory, "example-vue");
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
          comments: [{ comment: "<p>所属项目：example-react</p>" }],
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
          comments: [{ comment: "<p>所属项目：example-vue</p>" }],
        },
      ]),
    );
    await writeFile(
      configPath,
      JSON.stringify({
        currentUser: "me",
        source: { type: "fixture", path: "./bugs.json" },
        repositoriesByProject: {
          "example-react": reactRepo,
          "example-vue": vueRepo,
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
