import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  loadRawBugById,
  loadRawBugs,
  loadRawBugsWithMetadata,
} from "../plugins/one-click-repair/skills/zentao-frontend-bugfix/scripts/lib/source.mjs";

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

test("单个 Bug 详情失败不会中断同批其他 Bug 且错误信息已脱敏", async () => {
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
      detailUrlTemplate: "{baseUrl}/bugs/{bugId}?secret=query-value",
      detailResponsePath: "data",
      requestRetries: 0,
    },
  };
  const result = await loadRawBugsWithMetadata(config, {
    fetchImplementation: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/bugs") {
        return Response.json({ data: { bugs: [{ id: "1" }, { id: "2" }] } });
      }
      if (parsed.pathname === "/bugs/1") {
        return Response.json({ data: { id: "1", title: "成功" } });
      }
      return new Response("private response body", { status: 500 });
    },
  });
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].title, "成功");
  assert.equal(result.items[1].__fetchStatus, "detail_failed");
  assert.equal(result.items[1].__fetchError.status, 500);
  assert.doesNotMatch(JSON.stringify(result.items[1].__fetchError), /private|query-value/);
});

test("Retry-After 优先于指数退避", async () => {
  const delays = [];
  let attempts = 0;
  const config = {
    currentUser: "me",
    source: {
      type: "rest",
      baseUrl: "https://zentao.example.com",
      urlTemplate: "{baseUrl}/bugs?page={page}&limit={pageSize}",
      pageSize: 100,
      maxPages: 1,
      responseItemsPath: "data.bugs",
      requestRetries: 1,
      retryDelayMs: 10,
    },
  };
  await loadRawBugs(config, {
    delayImplementation: async (milliseconds) => delays.push(milliseconds),
    fetchImplementation: async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response("busy", { status: 429, headers: { "Retry-After": "2" } });
      }
      return Response.json({ data: { bugs: [] } });
    },
  });
  assert.deepEqual(delays, [2000]);
});

test("禅道单 Bug 查询只请求详情端点", async () => {
  const previous = process.env.TEST_SINGLE_BUG_TOKEN;
  process.env.TEST_SINGLE_BUG_TOKEN = "token";
  const requested = [];
  try {
    const bug = await loadRawBugById(
      {
        currentUser: "dev1",
        source: {
          type: "zentao-v1",
          baseUrl: "https://zentao.example.com/zentao",
          tokenEnv: "TEST_SINGLE_BUG_TOKEN",
          requestRetries: 0,
        },
      },
      "77",
      {
        fetchImplementation: async (url) => {
          requested.push(url);
          return Response.json({
            id: 77,
            title: "详情",
            status: "active",
            assignedTo: { account: "dev1" },
          });
        },
      },
    );
    assert.equal(bug.id, 77);
    assert.deepEqual(requested, ["https://zentao.example.com/zentao/api.php/v1/bugs/77"]);
  } finally {
    if (previous == null) delete process.env.TEST_SINGLE_BUG_TOKEN;
    else process.env.TEST_SINGLE_BUG_TOKEN = previous;
  }
});

test("某个产品 Bug 列表失败时继续处理其他产品", async () => {
  const previous = process.env.TEST_PARTIAL_PRODUCT_TOKEN;
  process.env.TEST_PARTIAL_PRODUCT_TOKEN = "token";
  try {
    const result = await loadRawBugsWithMetadata(
      {
        currentUser: "dev1",
        policy: { closedStatuses: ["closed"] },
        source: {
          type: "zentao-v1",
          personalBugListMode: "product-scan",
          baseUrl: "https://zentao.example.com/zentao",
          tokenEnv: "TEST_PARTIAL_PRODUCT_TOKEN",
          requestRetries: 0,
        },
      },
      {
        fetchImplementation: async (url) => {
          const pathname = new URL(url).pathname;
          if (pathname.endsWith("/products")) {
            return Response.json({
              total: 2,
              products: [{ id: 1, name: "失败产品" }, { id: 2, name: "正常产品" }],
            });
          }
          if (pathname.endsWith("/products/1/bugs")) {
            return new Response("private product error", { status: 500 });
          }
          if (pathname.endsWith("/products/2/bugs")) {
            return Response.json({
              total: 1,
              bugs: [
                { id: 21, product: 2, status: "active", assignedTo: { account: "dev1" } },
              ],
            });
          }
          if (pathname.endsWith("/bugs/21")) {
            return Response.json({
              id: 21,
              product: 2,
              title: "可继续处理",
              status: "active",
              assignedTo: { account: "dev1" },
            });
          }
          return new Response("not found", { status: 404 });
        },
      },
    );
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].id, 21);
    assert.equal(result.sourceErrors.length, 1);
    assert.equal(result.sourceErrors[0].productId, "1");
    assert.doesNotMatch(JSON.stringify(result.sourceErrors), /private product error/);
  } finally {
    if (previous == null) delete process.env.TEST_PARTIAL_PRODUCT_TOKEN;
    else process.env.TEST_PARTIAL_PRODUCT_TOKEN = previous;
  }
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
      personalBugListMode: "product-scan",
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

test("禅道默认只读取指派给我的列表且不请求产品列表", async () => {
  const previous = process.env.TEST_PERSONAL_ZENTAO_TOKEN;
  process.env.TEST_PERSONAL_ZENTAO_TOKEN = "personal-token";
  const requested = [];
  const page = `<div zui-create-dtable='{"data":[{"id":11,"title":"我的 Bug","status":"active","assignedTo":{"account":"dev1"}},{"id":12,"title":"其他人","status":"active","assignedTo":{"account":"dev2"}},{"id":13,"title":"已关闭","status":"closed","assignedTo":{"account":"dev1"}}],"recTotal":3,"recPerPage":100,"page":1}'></div>`;
  try {
    const result = await loadRawBugsWithMetadata(
      {
        currentUser: "dev1",
        policy: { closedStatuses: ["closed"] },
        source: {
          type: "zentao-v1",
          baseUrl: "https://zentao.example.com/zentao",
          tokenEnv: "TEST_PERSONAL_ZENTAO_TOKEN",
          requestRetries: 0,
        },
      },
      {
        fetchImplementation: async (url, init) => {
          requested.push(String(url));
          if (String(url).endsWith("my-work-bug-assignedTo--id_desc.html")) {
            return new Response(page);
          }
          assert.equal(init.headers.Token, "personal-token");
          return Response.json({
            id: 11,
            title: "我的 Bug 详情",
            product: { id: 2, name: "前端" },
            status: "active",
            assignedTo: { account: "dev1" },
          });
        },
      },
    );
    assert.deepEqual(result.items.map((item) => item.id), [11]);
    assert.equal(result.items[0].title, "我的 Bug 详情");
    assert.equal(result.requestSummary.listMode, "assigned-to-me");
    assert.equal(result.requestSummary.personalCandidateCount, 3);
    assert.equal(result.requestSummary.detailRequests, 1);
    assert.equal(requested.some((url) => url.includes("/products")), false);
    assert.deepEqual(requested, [
      "https://zentao.example.com/zentao/my-work-bug-assignedTo--id_desc.html",
      "https://zentao.example.com/zentao/api.php/v1/bugs/11",
    ]);
  } finally {
    if (previous == null) delete process.env.TEST_PERSONAL_ZENTAO_TOKEN;
    else process.env.TEST_PERSONAL_ZENTAO_TOKEN = previous;
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
          personalBugListMode: "product-scan",
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
            personalBugListMode: "product-scan",
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
