import assert from "node:assert/strict";
import test from "node:test";
import {
  keychainServiceFor,
  promptAndStoreKeychainPassword,
  readKeychainPassword,
} from "../plugins/one-click-repair/skills/zentao-frontend-bugfix/scripts/lib/keychain.mjs";

test("钥匙串服务名稳定且不同禅道地址相互隔离", () => {
  const first = keychainServiceFor("https://zentao.example.com/zentao/");
  assert.equal(first, keychainServiceFor("https://zentao.example.com/zentao"));
  assert.notEqual(first, keychainServiceFor("https://other.example.com/zentao"));
  assert.match(first, /^codex\.zentao-frontend-bugfix\.[a-f0-9]{20}$/);
});

test("保存密码时由 security 安全提示且命令参数不包含密码", async () => {
  let observed;
  await promptAndStoreKeychainPassword(
    {
      baseUrl: "https://zentao.example.com/zentao",
      account: "dev1",
    },
    {
      platform: "darwin",
      runSecurity: async (args, options) => {
        observed = { args, options };
        return { stdout: "", stderr: "" };
      },
    },
  );

  assert.equal(observed.options.interactive, true);
  assert.equal(observed.args.at(-1), "-w");
  assert.equal(observed.args.includes("password-value"), false);
  assert.deepEqual(observed.args.slice(0, 5), [
    "add-generic-password",
    "-U",
    "-a",
    "dev1",
    "-s",
  ]);
});

test("读取密码时只返回钥匙串标准输出且去除末尾换行", async () => {
  let observed;
  const password = await readKeychainPassword(
    {
      baseUrl: "https://zentao.example.com/zentao",
      account: "dev1",
    },
    {
      platform: "darwin",
      runSecurity: async (args, options) => {
        observed = { args, options };
        return { stdout: "password-value\n", stderr: "" };
      },
    },
  );

  assert.equal(password, "password-value");
  assert.equal(observed.options.interactive, false);
  assert.deepEqual(observed.args.slice(0, 5), [
    "find-generic-password",
    "-w",
    "-a",
    "dev1",
    "-s",
  ]);
});
