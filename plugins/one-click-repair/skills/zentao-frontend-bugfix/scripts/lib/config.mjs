import path from "node:path";
import { repositoryKeyForProject } from "./repository.mjs";
import { readJson, resolvePath } from "./utils.mjs";

const DEFAULT_POLICY = {
  closedStatuses: ["closed", "已关闭"],
  autoFixCategories: [
    "STYLE",
    "COPY",
    "FORM_VALIDATION",
    "NULL_GUARD",
    "API_MAPPING",
    "BUILD",
  ],
  humanRequiredCategories: ["STATE_LOGIC", "COMPATIBILITY", "PERFORMANCE"],
  minAutoFixConfidence: 0.75,
  humanReviewSeverityAtOrBelow: 1,
  highRiskKeywords: [],
};

const ZENTAO_V1_FIELDS = {
  id: "id",
  title: "title",
  description: "steps",
  steps: "steps",
  severity: "severity",
  priority: "pri",
  affectedVersion: "openedBuild",
  resolvedVersion: "resolvedBuild",
  product: "productName",
  project: "projectName",
  execution: "execution",
  executionName: "executionName",
  module: "moduleName",
  status: "status",
  assignee: "assignedTo",
  attachments: "files",
  comments: "actions",
};

function assertString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} 必须是非空字符串`);
  }
}

function validateNumber(value, label, { minimum = 0, integer = false } = {}) {
  if (value == null) return;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    (integer && !Number.isInteger(value))
  ) {
    throw new Error(`${label} 必须是${integer ? "整数且" : ""}不小于 ${minimum} 的数字`);
  }
}

function validateStringArray(value, label) {
  if (
    value != null &&
    (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item))
  ) {
    throw new Error(`${label} 必须是非空字符串数组`);
  }
}

export async function loadConfig(configPath) {
  const absoluteConfigPath = path.resolve(configPath);
  const configDir = path.dirname(absoluteConfigPath);
  const raw = await readJson(absoluteConfigPath);

  if (!raw.source || !["fixture", "rest", "zentao-v1"].includes(raw.source.type)) {
    throw new Error("source.type 必须是 fixture、rest 或 zentao-v1");
  }
  if (raw.source.type !== "zentao-v1") assertString(raw.currentUser, "currentUser");
  if (raw.currentUser != null) assertString(raw.currentUser, "currentUser");
  if (raw.source.type === "fixture") assertString(raw.source.path, "source.path");
  if (raw.source.type === "rest") {
    assertString(raw.source.urlTemplate, "source.urlTemplate");
    assertString(raw.source.responseItemsPath, "source.responseItemsPath");
    validateNumber(raw.source.pageStart, "source.pageStart", { minimum: 0, integer: true });
    validateNumber(raw.source.pageSize, "source.pageSize", { minimum: 1, integer: true });
    validateNumber(raw.source.maxPages, "source.maxPages", { minimum: 1, integer: true });
    validateNumber(raw.source.requestTimeoutMs, "source.requestTimeoutMs", {
      minimum: 1,
      integer: true,
    });
    validateNumber(raw.source.requestRetries, "source.requestRetries", {
      minimum: 0,
      integer: true,
    });
    validateNumber(raw.source.retryDelayMs, "source.retryDelayMs", {
      minimum: 0,
      integer: true,
    });
    validateNumber(raw.source.detailConcurrency, "source.detailConcurrency", {
      minimum: 1,
      integer: true,
    });
  }
  if (raw.source.type === "zentao-v1") {
    assertString(raw.source.baseUrl, "source.baseUrl");
    if (
      raw.source.personalBugListMode != null &&
      !["assigned-to-me", "product-scan"].includes(raw.source.personalBugListMode)
    ) {
      throw new Error(
        "source.personalBugListMode 必须是 assigned-to-me 或 product-scan",
      );
    }
    if (raw.source.personalBugListPath != null) {
      assertString(raw.source.personalBugListPath, "source.personalBugListPath");
    }
    if (
      raw.source.tokenEnv != null &&
      !/^[A-Z_][A-Z0-9_]*$/.test(raw.source.tokenEnv)
    ) {
      throw new Error("source.tokenEnv 必须是合法的环境变量名");
    }
    if (raw.source.tokenFile != null) assertString(raw.source.tokenFile, "source.tokenFile");
    if (raw.source.accountFile != null) assertString(raw.source.accountFile, "source.accountFile");
    if (
      raw.source.productIds != null &&
      (!Array.isArray(raw.source.productIds) ||
        raw.source.productIds.some(
          (id) => !["string", "number"].includes(typeof id) || String(id).trim() === "",
        ))
    ) {
      throw new Error("source.productIds 必须是产品 ID 数组");
    }
    for (const [field, minimum] of [
      ["productPageSize", 1],
      ["maxProductPages", 1],
      ["pageSize", 1],
      ["maxPagesPerProduct", 1],
      ["productConcurrency", 1],
      ["detailConcurrency", 1],
      ["requestTimeoutMs", 1],
      ["requestRetries", 0],
      ["retryDelayMs", 0],
      ["personalBugPageSize", 1],
      ["maxPersonalBugPages", 1],
    ]) {
      validateNumber(raw.source[field], `source.${field}`, { minimum, integer: true });
    }
    if (raw.source.personalBugPageSize > 1_000) {
      throw new Error("source.personalBugPageSize 不能大于 1000");
    }
  }
  if (raw.source.attachmentUrlTemplate != null) {
    assertString(raw.source.attachmentUrlTemplate, "source.attachmentUrlTemplate");
  }
  validateNumber(raw.source.maxAttachmentBytes, "source.maxAttachmentBytes", {
    minimum: 1,
    integer: true,
  });

  const repositoriesByProject = raw.repositoriesByProject ?? {};
  if (
    typeof repositoriesByProject !== "object" ||
    repositoriesByProject == null ||
    Array.isArray(repositoriesByProject)
  ) {
    throw new Error("repositoriesByProject 必须是以代码仓库名称为 key 的对象");
  }
  const normalizedRepositories = Object.fromEntries(
    Object.entries(repositoriesByProject).map(([projectName, value]) => {
      assertString(projectName, "repositoriesByProject 的代码仓库名称");
      const projectKey = repositoryKeyForProject(projectName);
      const entry = typeof value === "string" ? { repoPath: value } : value;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`repositoriesByProject.${projectName} 必须是仓库路径或配置对象`);
      }
      assertString(entry.repoPath, `repositoriesByProject.${projectName}.repoPath`);
      return [
        projectKey,
        {
          name: entry.name || path.basename(entry.repoPath),
          repoPath: resolvePath(configDir, entry.repoPath),
          projectName,
        },
      ];
    }),
  );

  validateStringArray(raw.policy?.closedStatuses, "policy.closedStatuses");
  validateStringArray(raw.policy?.autoFixCategories, "policy.autoFixCategories");
  validateStringArray(raw.policy?.humanRequiredCategories, "policy.humanRequiredCategories");
  validateStringArray(raw.policy?.highRiskKeywords, "policy.highRiskKeywords");
  validateNumber(raw.policy?.minAutoFixConfidence, "policy.minAutoFixConfidence", {
    minimum: 0,
  });
  if (raw.policy?.minAutoFixConfidence > 1) {
    throw new Error("policy.minAutoFixConfidence 不能大于 1");
  }
  validateNumber(
    raw.policy?.humanReviewSeverityAtOrBelow,
    "policy.humanReviewSeverityAtOrBelow",
    { minimum: 0 },
  );
  return {
    ...raw,
    source: {
      ...raw.source,
      path:
        raw.source.type === "fixture" ? resolvePath(configDir, raw.source.path) : raw.source.path,
      tokenEnv: raw.source.type === "zentao-v1" ? raw.source.tokenEnv || "ZENTAO_TOKEN" : undefined,
      personalBugListMode:
        raw.source.type === "zentao-v1"
          ? raw.source.personalBugListMode || "assigned-to-me"
          : undefined,
      personalBugListPath:
        raw.source.type === "zentao-v1"
          ? raw.source.personalBugListPath || "my-work-bug-assignedTo--id_desc.html"
          : undefined,
      personalBugPageSize:
        raw.source.type === "zentao-v1"
          ? raw.source.personalBugPageSize || 100
          : undefined,
      maxPersonalBugPages:
        raw.source.type === "zentao-v1"
          ? raw.source.maxPersonalBugPages || 20
          : undefined,
      tokenFile:
        raw.source.type === "zentao-v1"
          ? resolvePath(configDir, raw.source.tokenFile || ".bugfix-secrets/zentao-token")
          : undefined,
      accountFile:
        raw.source.type === "zentao-v1"
          ? resolvePath(configDir, raw.source.accountFile || ".bugfix-secrets/zentao-account")
          : undefined,
      fields:
        raw.source.type === "zentao-v1"
          ? { ...ZENTAO_V1_FIELDS, ...(raw.source.fields ?? {}) }
          : raw.source.fields,
    },
    outputDir: resolvePath(configDir, raw.outputDir || ".bugfix-output"),
    repositoriesByProject: normalizedRepositories,
    policy: {
      ...DEFAULT_POLICY,
      ...(raw.policy ?? {}),
      highRiskKeywords: [
        ...DEFAULT_POLICY.highRiskKeywords,
        ...(raw.policy?.highRiskKeywords ?? []),
      ],
    },
    __configPath: absoluteConfigPath,
    __configDir: configDir,
  };
}
