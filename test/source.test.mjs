import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadRawBugs } from "../plugins/one-click-repair/skills/zentao-frontend-bugfix/scripts/lib/source.mjs";

test("REST 数据源支持字段路径、环境变量和分页", async () => {
  const requested = [];
  const pages = {
    1: { data: { bugs: [{ id: 1 }, { id: 2 }], total: 3 } },
    2: { data: { bugs: [{ id: 3 }], total: 3 } },
  };
  const config = {
    currentUser: "zhangsan",
    source: {
      type: "rest",
      baseUrl: "https://zentao.example.com/",
      urlTemplate: "{baseUrl}/bugs?owner={currentUser}&page={page}&limit={pageSize}",
      pageStart: 1,
      pageSize: 2,
      maxPages: 5,
      headers: { Authorization: "Bearer ${TEST_ZENTAO_TOKEN}" },
      responseItemsPath: "data.bugs",
      responseTotalPath: "data.total",
    },
  };
  const previous = process.env.TEST_ZENTAO_TOKEN;
  process.env.TEST_ZENTAO_TOKEN = "secret";
  try {
    const bugs = await loadRawBugs(config, {
      fetchImplementation: async (url, init) => {
        requested.push({ url, authorization: init.headers.Authorization });
        const page = Number(new URL(url).searchParams.get("page"));
        return new Response(JSON.stringify(pages[page]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    assert.deepEqual(
      bugs.map((bug) => bug.id),
      [1, 2, 3],
    );
    assert.equal(requested.length, 2);
    assert.equal(requested[0].authorization, "Bearer secret");
    assert.match(requested[0].url, /owner=zhangsan/);
  } finally {
    if (previous == null) delete process.env.TEST_ZENTAO_TOKEN;
    else process.env.TEST_ZENTAO_TOKEN = previous;
  }
});

test("REST 数据源可重试临时错误并补拉 Bug 详情", async () => {
  let detailAttempts = 0;
  const config = {
    currentUser: "me",
    source: {
      type: "rest",
      baseUrl: "https://zentao.example.com",
      urlTemplate: "{baseUrl}/bugs?page={page}&limit={pageSize}",
      pageSize: 100,
      maxPages: 1,
      responseItemsPath: "data.bugs",
      fields: { id: "id" },
      detailUrlTemplate: "{baseUrl}/bugs/{bugId}",
      detailResponsePath: "data",
      detailConcurrency: 2,
      requestRetries: 1,
      retryDelayMs: 0,
      requestTimeoutMs: 1_000,
    },
  };

  const bugs = await loadRawBugs(config, {
    delayImplementation: async () => {},
    fetchImplementation: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/bugs" && parsed.search) {
        return Response.json({ data: { bugs: [{ id: "88", title: "列表标题" }] } });
      }
      detailAttempts += 1;
      if (detailAttempts === 1) {
        return new Response("temporary", { status: 503, statusText: "Unavailable" });
      }
      return Response.json({
        data: {
          id: "88",
          title: "详情标题",
          description: "完整的问题描述",
          steps: "完整复现步骤",
        },
      });
    },
  });

  assert.equal(detailAttempts, 2);
  assert.deepEqual(bugs, [
    {
      id: "88",
      title: "详情标题",
      description: "完整的问题描述",
      steps: "完整复现步骤",
    },
  ]);
});

test("达到分页上限且无法证明取完时拒绝返回不完整结果", async () => {
  const config = {
    currentUser: "me",
    source: {
      type: "rest",
      baseUrl: "https://zentao.example.com",
      urlTemplate: "{baseUrl}/bugs?page={page}&limit={pageSize}",
      pageSize: 1,
      maxPages: 1,
      responseItemsPath: "data.bugs",
      requestRetries: 0,
    },
  };
  await assert.rejects(
    loadRawBugs(config, {
      fetchImplementation: async () => Response.json({ data: { bugs: [{ id: "1" }] } }),
    }),
    /结果可能被截断/,
  );
});

test("禅道 21.6 适配器跨产品拉取、过滤当前用户并补拉详情", async () => {
  const previous = process.env.TEST_ZENTAO_V1_TOKEN;
  process.env.TEST_ZENTAO_V1_TOKEN = "token-value";
  const requests = [];
  const config = {
    currentUser: "dev1",
    policy: { closedStatuses: ["closed", "已关闭"] },
    source: {
      type: "zentao-v1",
      baseUrl: "https://zentao.example.com/zentao",
      tokenEnv: "TEST_ZENTAO_V1_TOKEN",
      productPageSize: 100,
      pageSize: 100,
      requestRetries: 0,
      retryDelayMs: 0,
    },
  };

  try {
    const bugs = await loadRawBugs(config, {
      fetchImplementation: async (url, init) => {
        requests.push({ url, token: init.headers.Token });
        const parsed = new URL(url);
        if (parsed.pathname.endsWith("/products")) {
          return Response.json({
            total: 2,
            products: [
              { id: 1, name: "后台产品" },
              { id: 2, name: "门户产品" },
            ],
          });
        }
        if (parsed.pathname.endsWith("/products/1/bugs")) {
          return Response.json({
            total: 2,
            bugs: [
              {
                id: 11,
                product: 1,
                title: "按钮文案错误",
                status: { code: "active", name: "激活" },
                assignedTo: { account: "dev1", realname: "开发一" },
              },
              {
                id: 12,
                product: 1,
                title: "其他人的 Bug",
                status: { code: "active", name: "激活" },
                assignedTo: { account: "dev2", realname: "开发二" },
              },
            ],
          });
        }
        if (parsed.pathname.endsWith("/products/2/bugs")) {
          return Response.json({
            total: 2,
            bugs: [
              {
                id: 21,
                product: 2,
                title: "页面空指针",
                status: "active",
                assignedTo: { account: "dev1" },
              },
              {
                id: 22,
                product: 2,
                title: "已关闭 Bug",
                status: "closed",
                assignedTo: { account: "dev1" },
              },
            ],
          });
        }
        if (parsed.pathname.endsWith("/bugs/11")) {
          return Response.json({
            id: 11,
            product: 1,
            projectName: "管理后台",
            execution: 101,
            executionName: "登录迭代",
            module: 8,
            steps: "<p>[步骤]进入登录页</p><p>[期望]显示登录</p>",
            status: "active",
            assignedTo: { account: "dev1" },
            files: [],
          });
        }
        if (parsed.pathname.endsWith("/bugs/21")) {
          return Response.json({
            id: 21,
            product: 2,
            projectName: "门户网站",
            execution: 201,
            executionName: "首页迭代",
            moduleName: "首页",
            steps: "进入首页后控制台出现 undefined 错误",
            status: "active",
            assignedTo: { account: "dev1" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    assert.equal(bugs.length, 2);
    assert.deepEqual(
      bugs.map((bug) => ({
        id: bug.id,
        productName: bug.productName,
        projectName: bug.projectName,
        execution: bug.execution,
        executionName: bug.executionName,
        moduleName: bug.moduleName,
      })),
      [
        {
          id: 11,
          productName: "后台产品",
          projectName: "管理后台",
          execution: 101,
          executionName: "登录迭代",
          moduleName: "8",
        },
        {
          id: 21,
          productName: "门户产品",
          projectName: "门户网站",
          execution: 201,
          executionName: "首页迭代",
          moduleName: "首页",
        },
      ],
    );
    assert.equal(requests.every((request) => request.token === "token-value"), true);
    assert.equal(requests.some((request) => request.url.includes("/bugs/12")), false);
    assert.equal(requests.some((request) => request.url.includes("/bugs/22")), false);
  } finally {
    if (previous == null) delete process.env.TEST_ZENTAO_V1_TOKEN;
    else process.env.TEST_ZENTAO_V1_TOKEN = previous;
  }
});

test("禅道 21.6 适配器可以从本地 Token 文件认证", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bugfix-token-file-"));
  try {
    const tokenFile = path.join(directory, "token");
    await writeFile(tokenFile, "file-token\n");
    let observedToken;
    const bugs = await loadRawBugs(
      {
        policy: { closedStatuses: ["closed"] },
        source: {
          type: "zentao-v1",
          baseUrl: "https://zentao.example.com",
          tokenEnv: "UNSET_ZENTAO_TEST_TOKEN",
          tokenFile,
          productPageSize: 100,
          requestRetries: 0,
        },
      },
      {
        fetchImplementation: async (_url, init) => {
          observedToken = init.headers.Token;
          if (_url.endsWith("/user")) {
            return Response.json({ profile: { account: "dev1", realname: "开发一" } });
          }
          return Response.json({ total: 0, products: [] });
        },
      },
    );
    assert.deepEqual(bugs, []);
    assert.equal(observedToken, "file-token");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("禅道 401 错误保留状态码供自动续期识别", async () => {
  const previous = process.env.TEST_EXPIRED_ZENTAO_TOKEN;
  process.env.TEST_EXPIRED_ZENTAO_TOKEN = "expired-token";
  try {
    await assert.rejects(
      loadRawBugs(
        {
          currentUser: "dev1",
          policy: { closedStatuses: ["closed"] },
          source: {
            type: "zentao-v1",
            baseUrl: "https://zentao.example.com",
            tokenEnv: "TEST_EXPIRED_ZENTAO_TOKEN",
            requestRetries: 0,
          },
        },
        {
          fetchImplementation: async () =>
            new Response('{"error":"Unauthorized"}', {
              status: 401,
              statusText: "Unauthorized",
            }),
        },
      ),
      (error) => error.status === 401,
    );
  } finally {
    if (previous == null) delete process.env.TEST_EXPIRED_ZENTAO_TOKEN;
    else process.env.TEST_EXPIRED_ZENTAO_TOKEN = previous;
  }
});
