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
      /明确授权修改/,
    );
    const prepared = await selectCurrentWorkspace(config, reportPath, "201", { confirmed: true });
    assert.equal(prepared.metadata.workspaceMode, "current");
    assert.equal(prepared.metadata.workspacePath, repoPath);
    assert.equal(prepared.metadata.userConfirmed, true);
    assert.equal(
      prepared.metadata.userAuthorization.basis,
      "explicit-confirmation",
    );
    assert.equal(
      prepared.metadata.userAuthorization.overridesTriageDecision,
      false,
    );
    assert.equal(prepared.metadata.verificationMode, "code-logic-review");
    assert.equal("validationCommands" in prepared.metadata, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("用户确认修改或给出具体方案后解锁待确认和人工处理，不解锁客观阻塞", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bugfix-authorization-"));
  try {
    const repoPath = path.join(directory, "repo");
    const outputDir = path.join(directory, "output");
    await mkdir(repoPath);
    const repository = {
      name: "example-react",
      repoPath,
      projectKey: "example-react",
      projectName: "example-react",
    };
    const makeItem = (id, decision) => ({
      bug: { id, title: `Bug ${id}`, description: "描述", steps: "步骤" },
      triage: { category: "STATE_LOGIC", decision, confidence: 0.8 },
      repository,
    });
    const reportPath = path.join(directory, "triage.json");
    await writeFile(
      reportPath,
      JSON.stringify({
        items: [
          makeItem("47643", "NEED_CONFIRM"),
          makeItem("90002", "HUMAN_REQUIRED"),
          {
            ...makeItem("47645", "BLOCKED"),
            repository: undefined,
          },
        ],
      }),
    );
    const config = { outputDir, policy: {} };

    const proposed = await selectCurrentWorkspace(
      config,
      reportPath,
      "90002",
      {
        confirmed: true,
        authorizationBasis: "user-provided-solution",
      },
    );
    assert.equal(
      proposed.metadata.userAuthorization.basis,
      "user-provided-solution",
    );
    assert.equal(
      proposed.metadata.userAuthorization.overridesTriageDecision,
      true,
    );

    const confirmed = await selectCurrentWorkspace(
      config,
      reportPath,
      "47643",
      {
        confirmed: true,
        authorizationBasis: "explicit-confirmation",
      },
    );
    assert.equal(
      confirmed.metadata.userAuthorization.overridesTriageDecision,
      true,
    );

    await assert.rejects(
      selectCurrentWorkspace(config, reportPath, "47645", {
        confirmed: true,
        authorizationBasis: "explicit-confirmation",
      }),
      /仓库或环境阻塞/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
