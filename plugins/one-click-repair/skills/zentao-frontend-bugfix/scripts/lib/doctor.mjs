import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { inspectRepository } from "./repository.mjs";
import { interpolateEnvironment } from "./utils.mjs";

function check(level, code, message, details = {}) {
  return { level, code, message, ...details };
}

export async function inspectConfig(config) {
  const checks = [];

  if (config.source.type === "fixture") {
    try {
      await access(config.source.path, constants.R_OK);
      checks.push(check("ok", "SOURCE_FIXTURE", "Fixture 文件可读", { path: config.source.path }));
    } catch {
      checks.push(
        check("error", "SOURCE_FIXTURE", "Fixture 文件不存在或不可读", {
          path: config.source.path,
        }),
      );
    }
  } else if (config.source.type === "zentao-v1") {
    const tokenEnv = config.source.tokenEnv || "ZENTAO_TOKEN";
    let tokenReady = Boolean(process.env[tokenEnv]);
    let accountReady = Boolean(config.currentUser);
    if (!tokenReady && config.source.tokenFile) {
      try {
        tokenReady = Boolean((await readFile(config.source.tokenFile, "utf8")).trim());
      } catch {
        tokenReady = false;
      }
    }
    if (!accountReady && config.source.accountFile) {
      try {
        accountReady = Boolean((await readFile(config.source.accountFile, "utf8")).trim());
      } catch {
        accountReady = false;
      }
    }
    checks.push(
      tokenReady
        ? check("ok", "SOURCE_AUTH", "禅道 Token 已在本地安全来源中就绪")
        : accountReady
          ? check(
              "ok",
              "SOURCE_AUTH",
              "禅道账号已初始化；缺少或失效的 Token 将通过 macOS 钥匙串自动刷新",
            )
        : check(
            "error",
            "SOURCE_AUTH",
            "禅道尚未初始化，请先在 One-Click-Repair 中运行 npm run bootstrap",
          ),
    );
    checks.push(
      check("ok", "SOURCE_ZENTAO_V1", "禅道 21.6 REST API v1 配置结构有效；尚未发起网络请求", {
        baseUrl: config.source.baseUrl,
        productCountLimit: config.source.productIds?.length,
      }),
    );
  } else {
    try {
      interpolateEnvironment(config.source.headers ?? {});
      checks.push(check("ok", "SOURCE_AUTH", "REST 认证环境变量已就绪"));
    } catch (error) {
      checks.push(check("error", "SOURCE_AUTH", error.message));
    }
    checks.push(
      check("ok", "SOURCE_REST", "REST 配置结构有效；尚未发起网络请求", {
        baseUrl: config.source.baseUrl,
        hasDetailRequest: Boolean(config.source.detailUrlTemplate),
      }),
    );
  }

  const repositoryEntries = Object.entries(config.repositoriesByProject ?? {});
  if (repositoryEntries.length === 0) {
    checks.push(check("error", "REPOSITORY_MAPPING", "尚未按所属项目配置当前仓库目录"));
  } else {
    for (const [projectKey, mapping] of repositoryEntries) {
      const repository = await inspectRepository(mapping);
      checks.push(
        repository.available
          ? check("ok", "REPOSITORY", `所属项目 ${mapping.projectName || projectKey} 的当前仓库目录可用`, {
              projectKey,
              projectName: mapping.projectName || projectKey,
              name: mapping.name,
              path: mapping.repoPath,
            })
          : check("error", "REPOSITORY", repository.blocker, {
              projectKey,
              projectName: mapping.projectName || projectKey,
              name: mapping.name,
              path: mapping.repoPath,
            }),
      );
    }
  }

  return {
    ok: checks.every((item) => item.level !== "error"),
    checkedAt: new Date().toISOString(),
    configPath: config.__configPath,
    checks,
  };
}
