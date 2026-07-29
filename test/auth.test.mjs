import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ensureZentaoToken,
  setupZentaoCredentials,
  withAutomaticTokenRefresh,
} from "../skills/zentao-frontend-bugfix/scripts/lib/auth.mjs";

function zentaoConfig(directory) {
  return {
    source: {
      type: "zentao-v1",
      baseUrl: "https://zentao.example.com/zentao",
      tokenEnv: "UNSET_TEST_ZENTAO_TOKEN",
      tokenFile: path.join(directory, ".bugfix-secrets", "zentao-token"),
      accountFile: path.join(directory, ".bugfix-secrets", "zentao-account"),
      requestTimeoutMs: 1_000,
    },
  };
}

test("setup 只询问账号，密码通过钥匙串保存并生成 Token", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bugfix-setup-"));
  try {
    const config = zentaoConfig(directory);
    let storedCredential;
    let observedRequest;
    const result = await setupZentaoCredentials(config, {
      readAccount: async (prompt) => {
        assert.match(prompt, /账号/);
        return "dev1";
      },
      storeKeychainPassword: async (credential) => {
        storedCredential = credential;
      },
      readKeychainPassword: async (credential) => {
        assert.deepEqual(credential, storedCredential);
        return "password-value";
      },
      fetchImplementation: async (url, init) => {
        observedRequest = {
          url,
          method: init.method,
          body: JSON.parse(init.body),
        };
        return Response.json({ token: "generated-token" });
      },
    });

    assert.deepEqual(storedCredential, {
      baseUrl: "https://zentao.example.com/zentao",
      account: "dev1",
    });
    assert.deepEqual(observedRequest, {
      url: "https://zentao.example.com/zentao/api.php/v1/tokens",
      method: "POST",
      body: { account: "dev1", password: "password-value" },
    });
    assert.equal(result.credentialStore, "macOS Keychain");
    assert.equal(config.currentUser, "dev1");
    assert.equal(await readFile(config.source.accountFile, "utf8"), "dev1\n");
    assert.equal(await readFile(config.source.tokenFile, "utf8"), "generated-token\n");
    assert.equal((await stat(config.source.accountFile)).mode & 0o777, 0o600);
    assert.equal((await stat(config.source.tokenFile)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("没有 Token 时从钥匙串自动登录", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bugfix-refresh-missing-"));
  try {
    const config = zentaoConfig(directory);
    await mkdir(path.dirname(config.source.accountFile), { recursive: true });
    await writeFile(config.source.accountFile, "dev1\n");
    let passwordReads = 0;
    const result = await ensureZentaoToken(config, {
      readKeychainPassword: async () => {
        passwordReads += 1;
        return "password-value";
      },
      fetchImplementation: async () => Response.json({ token: "new-token" }),
    });

    assert.equal(result.source, "keychain");
    assert.equal(result.refreshed, true);
    assert.equal(passwordReads, 1);
    assert.equal(await readFile(config.source.tokenFile, "utf8"), "new-token\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("已有 Token 时不会读取钥匙串", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bugfix-existing-token-"));
  try {
    const config = zentaoConfig(directory);
    await mkdir(path.dirname(config.source.tokenFile), { recursive: true });
    await writeFile(config.source.tokenFile, "existing-token\n");
    const result = await ensureZentaoToken(config, {
      readKeychainPassword: async () => {
        throw new Error("不应读取钥匙串");
      },
    });

    assert.equal(result.source, "file");
    assert.equal(result.created, false);
    assert.equal(result.refreshed, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("尚未初始化时提示先运行 setup", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bugfix-no-setup-"));
  try {
    const config = zentaoConfig(directory);
    await assert.rejects(
      ensureZentaoToken(config, {
        readKeychainPassword: async () => {
          throw new Error("不应在没有账号时读取钥匙串");
        },
      }),
      (error) =>
        error.code === "ZENTAO_SETUP_REQUIRED" &&
        /npm run setup/.test(error.message),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("请求返回 401 时自动刷新 Token 并只重试一次", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bugfix-refresh-401-"));
  try {
    const config = zentaoConfig(directory);
    await mkdir(path.dirname(config.source.accountFile), { recursive: true });
    await writeFile(config.source.accountFile, "dev1\n");
    let attempts = 0;
    let tokenRequests = 0;
    const result = await withAutomaticTokenRefresh(
      config,
      async () => {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error("unauthorized");
          error.status = 401;
          throw error;
        }
        return "triage-complete";
      },
      {
        readKeychainPassword: async () => "password-value",
        fetchImplementation: async () => {
          tokenRequests += 1;
          return Response.json({ token: "refreshed-token" });
        },
      },
    );

    assert.deepEqual(result, {
      value: "triage-complete",
      tokenAutoRefreshed: true,
    });
    assert.equal(attempts, 2);
    assert.equal(tokenRequests, 1);
    assert.equal(await readFile(config.source.tokenFile, "utf8"), "refreshed-token\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("非 401 错误不会触发自动登录", async () => {
  const config = zentaoConfig(os.tmpdir());
  let passwordReads = 0;
  await assert.rejects(
    withAutomaticTokenRefresh(
      config,
      async () => {
        const error = new Error("server error");
        error.status = 500;
        throw error;
      },
      {
        readKeychainPassword: async () => {
          passwordReads += 1;
          return "should-not-be-read";
        },
      },
    ),
    /server error/,
  );
  assert.equal(passwordReads, 0);
});
