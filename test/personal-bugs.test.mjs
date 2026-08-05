import assert from "node:assert/strict";
import test from "node:test";

import {
  loadPersonalBugList,
  parsePersonalBugPage,
} from "../plugins/one-click-repair/skills/zentao-frontend-bugfix/scripts/lib/personal-bugs.mjs";

function listPage(items, options = {}) {
  const config = `{
    "data":${JSON.stringify(items)},
    "recTotal":${options.total ?? items.length},
    "recPerPage":${options.pageSize ?? 100},
    "page":${options.page ?? 1},
    "linkCreator":"${options.linkCreator || "/zentao/my-work-bug-assignedTo--id_desc-{recPerPage}-{page}.html"}",
    "onRenderCell":function(event){ return event.row.data.title => event.value; }
  }`;
  return `<html><div zui-create-dtable='${config}'></div></html>`;
}

function config(overrides = {}) {
  return {
    currentUser: "dev1",
    source: {
      type: "zentao-v1",
      baseUrl: "https://zentao.example.com/zentao",
      requestTimeoutMs: 1_000,
      personalBugPageSize: 100,
      maxPersonalBugPages: 20,
      ...overrides,
    },
  };
}

test("只解析个人 Bug 页中的纯 JSON data，不执行外层 JavaScript", () => {
  globalThis.__personalBugParserExecuted = false;
  const parsed = parsePersonalBugPage(
    listPage([{ id: 1, title: "我的 Bug" }], { total: 1 }),
  );
  assert.deepEqual(parsed.items, [{ id: 1, title: "我的 Bug" }]);
  assert.equal(parsed.total, 1);
  assert.equal(globalThis.__personalBugParserExecuted, false);
  delete globalThis.__personalBugParserExecuted;
});

test("兼容禅道页面中 HTML 实体编码的双引号组件配置", () => {
  const encoded = '{"data":[{"id":9,"title":"实体编码"}],"recTotal":1,"recPerPage":20,"page":1}'
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;");
  const parsed = parsePersonalBugPage(
    `<div class="dtable" zui-create-dtable="${encoded}"></div>`,
  );
  assert.equal(parsed.items[0].id, 9);
  assert.equal(parsed.items[0].title, "实体编码");
});

test("无 Web Session 时使用钥匙串密码同源登录且不返回凭据", async () => {
  const requests = [];
  const result = await loadPersonalBugList(config(), {
    readKeychainPassword: async () => "private-password",
    fetchImplementation: async (url, init) => {
      requests.push({ url: String(url), method: init.method || "GET", body: String(init.body || "") });
      if (requests.length === 1) {
        return new Response(null, {
          status: 302,
          headers: {
            Location: "/zentao/user-login.html",
            "Set-Cookie": "zentaosid=first; Path=/; HttpOnly",
          },
        });
      }
      if (requests.length === 2) {
        return new Response(
          '<form action="/zentao/user-login.html"><input name="account"><input name="password" type="password"></form>',
        );
      }
      if (requests.length === 3) {
        return new Response(null, {
          status: 302,
          headers: { Location: "/zentao/my.html", "Set-Cookie": "zentaosid=second; Path=/" },
        });
      }
      return new Response(listPage([{ id: 8, assignedTo: { account: "dev1" } }]));
    },
  });
  assert.equal(result.items[0].id, 8);
  assert.equal(requests.length, 4);
  assert.equal(requests[2].method, "POST");
  assert.match(requests[2].body, /account=dev1/);
  assert.match(requests[2].body, /password=private-password/);
  assert.doesNotMatch(JSON.stringify(result), /private-password|zentaosid/);
});

test("拒绝跨域登录跳转且不会读取钥匙串密码", async () => {
  let passwordRead = false;
  await assert.rejects(
    loadPersonalBugList(config(), {
      readKeychainPassword: async () => {
        passwordRead = true;
        return "secret";
      },
      fetchImplementation: async () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://attacker.example/login" },
        }),
    }),
    /同源地址/,
  );
  assert.equal(passwordRead, false);
});

test("个人 Bug 列表按页面模板分页并按 ID 去重", async () => {
  const urls = [];
  const result = await loadPersonalBugList(
    config({ personalBugPageSize: 2 }),
    {
      fetchImplementation: async (url) => {
        urls.push(String(url));
        return new Response(
          urls.length === 1
            ? listPage([{ id: 1 }, { id: 2 }], { total: 3, pageSize: 2 })
            : listPage([{ id: 2 }, { id: 3 }], { total: 3, pageSize: 2, page: 2 }),
        );
      },
    },
  );
  assert.deepEqual(result.items.map((item) => item.id), [1, 2, 3]);
  assert.equal(result.requestSummary.personalListPages, 2);
  assert.match(urls[1], /-2-2\.html$/u);
});

test("检测到验证码登录表单时停止自动登录", async () => {
  let requestCount = 0;
  await assert.rejects(
    loadPersonalBugList(config(), {
      readKeychainPassword: async () => "secret",
      fetchImplementation: async (_url, _init) => {
        requestCount += 1;
        if (requestCount === 1) {
          return new Response(null, {
            status: 302,
            headers: { Location: "/zentao/login" },
          });
        }
        return new Response(
          '<form action="/zentao/login"><input name="account"><input name="password"><input name="captcha"></form>',
        );
      },
    }),
    /登录表单|验证码/,
  );
});
