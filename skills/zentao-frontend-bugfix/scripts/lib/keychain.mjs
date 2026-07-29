import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import process from "node:process";

function runSecurity(args, { interactive = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/security", args, {
      stdio: interactive ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    if (!interactive) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
    }
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const error = new Error(`macOS 钥匙串命令执行失败（退出码 ${code}）`);
      error.code = "KEYCHAIN_COMMAND_FAILED";
      reject(error);
    });
  });
}

function requireMacOS(platform = process.platform) {
  if (platform !== "darwin") {
    throw new Error("自动续期目前需要 macOS 钥匙串");
  }
}

export function keychainServiceFor(baseUrl) {
  const normalized = String(baseUrl || "").replace(/\/+$/g, "");
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 20);
  return `codex.zentao-frontend-bugfix.${digest}`;
}

export async function promptAndStoreKeychainPassword(
  { baseUrl, account },
  options = {},
) {
  requireMacOS(options.platform);
  const service = options.service || keychainServiceFor(baseUrl);
  const runner = options.runSecurity || runSecurity;
  const label = `Codex 禅道自动续期（${baseUrl}）`;
  await runner(
    [
      "add-generic-password",
      "-U",
      "-a",
      account,
      "-s",
      service,
      "-l",
      label,
      "-w",
    ],
    { interactive: true },
  );
  return { service };
}

export async function readKeychainPassword({ baseUrl, account }, options = {}) {
  requireMacOS(options.platform);
  const service = options.service || keychainServiceFor(baseUrl);
  const runner = options.runSecurity || runSecurity;
  let result;
  try {
    result = await runner(
      ["find-generic-password", "-w", "-a", account, "-s", service],
      { interactive: false },
    );
  } catch (cause) {
    const error = new Error("macOS 钥匙串中没有可用的禅道登录凭据", { cause });
    error.code = "KEYCHAIN_CREDENTIAL_MISSING";
    throw error;
  }
  const password = String(result.stdout || "").replace(/\r?\n$/, "");
  if (!password) {
    const error = new Error("macOS 钥匙串中的禅道密码为空");
    error.code = "KEYCHAIN_CREDENTIAL_MISSING";
    throw error;
  }
  return password;
}
