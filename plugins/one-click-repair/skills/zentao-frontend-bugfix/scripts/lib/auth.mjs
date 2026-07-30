import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import {
  promptAndStoreKeychainPassword,
  readKeychainPassword,
} from "./keychain.mjs";
import {
  isZentaoUnauthorized,
  requestZentaoV1Token,
} from "./source.mjs";

export async function writeTokenFile(filePath, token) {
  if (!filePath) throw new Error("配置缺少 source.tokenFile");
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, `${token.trim()}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(filePath, 0o600);
  return filePath;
}

export async function writeAccountFile(filePath, account) {
  if (!filePath) throw new Error("配置缺少 source.accountFile");
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, `${account.trim()}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(filePath, 0o600);
  return filePath;
}

export async function readHiddenValue(prompt) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("必须在交互式终端中运行该命令");
  }
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  let password = "";

  try {
    return await new Promise((resolve, reject) => {
      const onData = (chunk) => {
        for (const character of chunk) {
          if (character === "\u0003") {
            process.stdin.off("data", onData);
            reject(new Error("已取消"));
            return;
          }
          if (character === "\r" || character === "\n") {
            process.stdin.off("data", onData);
            process.stdout.write("\n");
            resolve(password);
            return;
          }
          if (character === "\u007f" || character === "\b") {
            password = password.slice(0, -1);
          } else {
            password += character;
          }
        }
      };
      process.stdin.on("data", onData);
    });
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

export async function readVisibleValue(prompt) {
  if (!process.stdin.isTTY) {
    throw new Error("必须在交互式终端中运行该命令");
  }
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return await readline.question(prompt);
  } finally {
    readline.close();
  }
}

export async function readStoredAccount(config) {
  if (config.currentUser?.trim()) return config.currentUser.trim();
  if (config.source.accountFile) {
    try {
      const account = (await readFile(config.source.accountFile, "utf8")).trim();
      if (account) return account;
    } catch {
      // A missing account file means setup has not completed.
    }
  }
  const error = new Error(
    "尚未初始化禅道账号，请运行 npx one-click-repair@latest setup（源码安装可运行 npm run bootstrap）",
  );
  error.code = "ZENTAO_SETUP_REQUIRED";
  throw error;
}

export async function findStoredToken(config) {
  if (config.source.type !== "zentao-v1") return { ready: true, source: "not-required" };
  const tokenEnv = config.source.tokenEnv || "ZENTAO_TOKEN";
  if (process.env[tokenEnv]) return { ready: true, source: "environment" };
  if (config.source.tokenFile) {
    try {
      const token = (await readFile(config.source.tokenFile, "utf8")).trim();
      if (token) return { ready: true, source: "file" };
    } catch {
      // First start is expected to have no token file.
    }
  }
  return { ready: false };
}

export async function refreshZentaoTokenFromKeychain(config, options = {}) {
  if (config.source.type !== "zentao-v1") {
    throw new Error("自动刷新 Token 只支持 source.type=zentao-v1");
  }
  if (!config.source.tokenFile) throw new Error("配置缺少 source.tokenFile");
  const account = await readStoredAccount(config);
  const readPassword = options.readKeychainPassword || readKeychainPassword;
  const password = await readPassword(
    { baseUrl: config.source.baseUrl, account },
    options.keychainOptions,
  );
  let token;
  try {
    token = await requestZentaoV1Token(
      {
        baseUrl: config.source.baseUrl,
        account,
        password,
        timeoutMs: config.source.requestTimeoutMs,
      },
      {
        fetchImplementation: options.fetchImplementation,
        delayImplementation: options.delayImplementation,
      },
    );
  } catch (cause) {
    if (isZentaoUnauthorized(cause)) {
      const error = new Error("钥匙串中的禅道账号或密码已失效，请重新运行 npx one-click-repair@latest setup（源码安装可运行 npm run bootstrap）", {
        cause,
      });
      error.code = "ZENTAO_CREDENTIAL_INVALID";
      throw error;
    }
    throw cause;
  }
  const tokenFile = await writeTokenFile(config.source.tokenFile, token);
  const tokenEnv = config.source.tokenEnv || "ZENTAO_TOKEN";
  if (process.env[tokenEnv]) process.env[tokenEnv] = token;
  config.currentUser = account;
  return {
    ready: true,
    source: "keychain",
    created: true,
    tokenFile,
    refreshed: true,
  };
}

export async function setupZentaoCredentials(config, options = {}) {
  if (config.source.type !== "zentao-v1") {
    throw new Error("setup 命令只支持 source.type=zentao-v1");
  }
  const readAccount = options.readAccount || readVisibleValue;
  const account = (await readAccount("禅道登录账号："))?.trim();
  if (!account) throw new Error("禅道登录账号不能为空");

  const storePassword = options.storeKeychainPassword || promptAndStoreKeychainPassword;
  await storePassword(
    { baseUrl: config.source.baseUrl, account },
    options.keychainOptions,
  );
  await writeAccountFile(config.source.accountFile, account);
  config.currentUser = account;
  const refreshed = await refreshZentaoTokenFromKeychain(config, options);
  return {
    accountFile: config.source.accountFile,
    tokenFile: refreshed.tokenFile,
    credentialStore: "macOS Keychain",
  };
}

export async function ensureZentaoToken(config, options = {}) {
  const stored = await findStoredToken(config);
  if (stored.ready) return { ...stored, created: false, refreshed: false };
  try {
    return await refreshZentaoTokenFromKeychain(config, options);
  } catch (error) {
    if (
      error.code === "ZENTAO_SETUP_REQUIRED" ||
      error.code === "KEYCHAIN_CREDENTIAL_MISSING"
    ) {
      const setupError = new Error("禅道尚未初始化，请先运行一次 npx one-click-repair@latest setup（源码安装可运行 npm run bootstrap）", {
        cause: error,
      });
      setupError.code = "ZENTAO_SETUP_REQUIRED";
      throw setupError;
    }
    throw error;
  }
}

export async function withAutomaticTokenRefresh(config, operation, options = {}) {
  try {
    return { value: await operation(), tokenAutoRefreshed: false };
  } catch (error) {
    if (!isZentaoUnauthorized(error)) throw error;
  }
  await refreshZentaoTokenFromKeychain(config, options);
  return { value: await operation(), tokenAutoRefreshed: true };
}
