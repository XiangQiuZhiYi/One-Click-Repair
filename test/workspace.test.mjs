import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { selectCurrentWorkspace } from "../plugins/one-click-repair/skills/zentao-frontend-bugfix/scripts/lib/workspace.mjs";

test("确认修改后直接选择用户当前仓库且不配置项目脚本验证", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bugfix-workspace-"));
  try {
    const repoPath = path.join(directory, "repo");
    const outputDir = path.join(directory, "output");
    await mkdir(repoPath);
    await writeFile(path.join(repoPath, "package.json"), "{}\n");

    const reportPath = path.join(directory, "triage.json");
    await writeFile(
      reportPath,
      JSON.stringify({
        items: [
          {
            bug: {
              id: "201",
              title: "修复按钮文案",
              description: "按钮文案应显示为保存。",
              steps: "打开页面即可看到。",
            },
            triage: {
              category: "COPY",
              decision: "AUTO_FIX",
              confidence: 0.9,
            },
            repository: {
              name: "demo-web",
              repoPath,
              projectKey: "demo-web",
              projectName: "demo-web",
            },
          },
        ],
      }),
    );

    const config = {
      outputDir,
      policy: {},
    };
    await assert.rejects(
      selectCurrentWorkspace(config, reportPath, "201"),
      /确认修改/,
    );
    const prepared = await selectCurrentWorkspace(config, reportPath, "201", { confirmed: true });
    assert.equal(prepared.metadata.workspaceMode, "current");
    assert.equal(prepared.metadata.workspacePath, repoPath);
    assert.equal(prepared.metadata.userConfirmed, true);
    assert.equal(prepared.metadata.verificationMode, "code-logic-review");
    assert.equal("validationCommands" in prepared.metadata, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
