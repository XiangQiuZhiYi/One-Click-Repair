import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectConfig } from "../plugins/one-click-repair/skills/zentao-frontend-bugfix/scripts/lib/doctor.mjs";

test("接入自检识别按所属项目保存的可用仓库", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bugfix-doctor-"));
  try {
    const repoPath = path.join(directory, "repo");
    const fixturePath = path.join(directory, "bugs.json");
    await mkdir(repoPath);
    await writeFile(path.join(repoPath, "package.json"), "{}\n");
    await writeFile(fixturePath, "[]\n");

    const result = await inspectConfig({
      currentUser: "me",
      __configPath: path.join(directory, "config.json"),
      source: { type: "fixture", path: fixturePath },
      repositoriesByProject: {
        "example-react": {
          name: "web",
          repoPath,
          projectName: "example-react",
        },
      },
    });

    assert.equal(result.ok, true);
    assert.ok(result.checks.some((item) => item.code === "SOURCE_FIXTURE" && item.level === "ok"));
    assert.ok(result.checks.some((item) => item.code === "REPOSITORY" && item.level === "ok"));
    assert.ok(result.checks.some((item) => item.projectKey === "example-react"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("接入自检不会请求 REST，但会发现缺少认证环境变量", async () => {
  const previous = process.env.DOCTOR_MISSING_TOKEN;
  delete process.env.DOCTOR_MISSING_TOKEN;
  try {
    const result = await inspectConfig({
      currentUser: "me",
      __configPath: "/tmp/config.json",
      source: {
        type: "rest",
        baseUrl: "https://zentao.example.com",
        headers: { Authorization: "Bearer ${DOCTOR_MISSING_TOKEN}" },
      },
      repositoriesByProject: {},
    });
    assert.equal(result.ok, false);
    assert.ok(result.checks.some((item) => item.code === "SOURCE_AUTH" && item.level === "error"));
  } finally {
    if (previous != null) process.env.DOCTOR_MISSING_TOKEN = previous;
  }
});

test("禅道 21.6 自检检查 Token 环境变量但不发送请求", async () => {
  const previous = process.env.DOCTOR_ZENTAO_V1_TOKEN;
  process.env.DOCTOR_ZENTAO_V1_TOKEN = "local-secret";
  try {
    const result = await inspectConfig({
      currentUser: "dev1",
      __configPath: "/tmp/config.json",
      source: {
        type: "zentao-v1",
        baseUrl: "https://zentao.example.com",
        tokenEnv: "DOCTOR_ZENTAO_V1_TOKEN",
      },
      repositoriesByProject: {},
    });
    assert.ok(
      result.checks.some((item) => item.code === "SOURCE_ZENTAO_V1" && item.level === "ok"),
    );
    assert.ok(result.checks.some((item) => item.code === "SOURCE_AUTH" && item.level === "ok"));
    assert.equal(
      result.checks.some((item) => JSON.stringify(item).includes("local-secret")),
      false,
    );
  } finally {
    if (previous == null) delete process.env.DOCTOR_ZENTAO_V1_TOKEN;
    else process.env.DOCTOR_ZENTAO_V1_TOKEN = previous;
  }
});

test("禅道账号已初始化时允许后续从钥匙串刷新 Token", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bugfix-doctor-account-"));
  try {
    const accountFile = path.join(directory, "zentao-account");
    await writeFile(accountFile, "dev1\n");
    const result = await inspectConfig({
      __configPath: path.join(directory, "config.json"),
      source: {
        type: "zentao-v1",
        baseUrl: "https://zentao.example.com",
        tokenEnv: "UNSET_DOCTOR_REFRESH_TOKEN",
        tokenFile: path.join(directory, "missing-token"),
        accountFile,
      },
      repositoriesByProject: {},
    });

    assert.ok(
      result.checks.some(
        (item) =>
          item.code === "SOURCE_AUTH" &&
          item.level === "ok" &&
          /钥匙串自动刷新/.test(item.message),
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
