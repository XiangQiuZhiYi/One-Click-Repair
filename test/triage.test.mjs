import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../skills/zentao-frontend-bugfix/scripts/lib/config.mjs";
import { writeTriageReport } from "../skills/zentao-frontend-bugfix/scripts/lib/report.mjs";
import { triageBugs } from "../skills/zentao-frontend-bugfix/scripts/lib/triage.mjs";

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
        repositoriesByExecution: {
          "100": repoPath,
        },
      }),
    );

    const config = await loadConfig(configPath);
    const items = await triageBugs(config);
    assert.equal(items.length, 2);
    assert.equal(items[0].triage.decision, "AUTO_FIX");
    assert.equal(items[0].repositoryKey, "100");
    assert.equal(items[0].repository.executionKey, "100");
    assert.equal(items[1].triage.decision, "BLOCKED");
    assert.equal(items[1].repositoryKey, "200");

    const output = await writeTriageReport(config, items);
    assert.equal(output.report.stats.byDecision.AUTO_FIX, 1);
    assert.equal(output.report.stats.byDecision.BLOCKED, 1);
    assert.match(await readFile(output.markdownPath, "utf8"), /Bug 总数：2/);
    assert.match(await readFile(output.markdownPath, "utf8"), /可直接修改（等待用户确认修改）/);
    assert.match(await readFile(output.markdownPath, "utf8"), /仓库或环境待配置/);
    assert.match(await readFile(output.markdownPath, "utf8"), /Web 迭代/);
    assert.match(await readFile(path.join(config.outputDir, "bugs", "101.md"), "utf8"), /AUTO_FIX/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
