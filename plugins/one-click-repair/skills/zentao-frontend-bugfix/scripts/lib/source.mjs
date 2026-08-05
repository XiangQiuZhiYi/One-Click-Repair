import { readFile } from "node:fs/promises";
import { loadPersonalBugList } from "./personal-bugs.mjs";
import { getByPath, interpolateEnvironment, printableValue, readJson } from "./utils.mjs";

function renderUrl(template, variables) {
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_, name) => {
    if (variables[name] == null) throw new Error(`URL 模板缺少变量：${name}`);
    const value = String(variables[name]);
    return name === "baseUrl" ? value : encodeURIComponent(value);
  });
}

async function loadFixture(source) {
  const data = await readJson(source.path);
  const items = source.responseItemsPath ? getByPath(data, source.responseItemsPath) : data;
  if (!Array.isArray(items)) {
    throw new Error(`Fixture 数据必须是数组：${source.path}`);
  }
  return items;
}

function shouldRetryStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function retryAfterMilliseconds(response) {
  const value = response.headers?.get?.("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, 30_000);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.min(Math.max(0, timestamp - Date.now()), 30_000);
}

export function sanitizeSourceError(error, context = "禅道数据获取失败") {
  const status = Number(error?.status);
  const timeout = error?.name === "AbortError" || error?.code === "REQUEST_TIMEOUT";
  return {
    type: timeout ? "timeout" : Number.isFinite(status) ? "http" : "network",
    ...(Number.isFinite(status) ? { status } : {}),
    retryable:
      timeout || (Number.isFinite(status) ? shouldRetryStatus(status) : true),
    message: timeout
      ? `${context}：请求超时`
      : Number.isFinite(status)
        ? `${context}：HTTP ${status}`
        : `${context}：网络或响应异常`,
  };
}

async function defaultDelay(milliseconds) {
  if (milliseconds <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function requestJson(url, requestOptions, runtime) {
  const retries = Number(requestOptions.retries ?? 2);
  const timeoutMs = Number(requestOptions.timeoutMs ?? 15_000);
  const retryDelayMs = Number(requestOptions.retryDelayMs ?? 300);
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      runtime.requestCount = (runtime.requestCount ?? 0) + 1;
      if (attempt > 0) runtime.retryCount = (runtime.retryCount ?? 0) + 1;
      const response = await runtime.fetchImplementation(url, {
        method: requestOptions.method || "GET",
        headers: requestOptions.headers,
        body: requestOptions.body,
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = new Error(`禅道请求失败：HTTP ${response.status}`);
        error.status = response.status;
        error.retryAfterMs = retryAfterMilliseconds(response);
        if (!shouldRetryStatus(response.status) || attempt === retries) throw error;
        lastError = error;
      } else {
        return await response.json();
      }
    } catch (error) {
      const retryable =
        error.name === "AbortError" ||
        error.name === "TypeError" ||
        /HTTP (408|429|5\d\d)/.test(error.message);
      if (!retryable || attempt === retries) {
        if (error.name === "AbortError") {
          const timeoutError = new Error(`禅道请求超时（${timeoutMs}ms）`);
          timeoutError.code = "REQUEST_TIMEOUT";
          throw timeoutError;
        }
        throw error;
      }
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }
    const exponentialDelay = Math.min(retryDelayMs * (2 ** attempt), 30_000);
    await runtime.delayImplementation(lastError?.retryAfterMs ?? exponentialDelay);
  }
  throw lastError || new Error(`禅道请求失败：${url}`);
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  const workerCount = Math.max(1, Math.min(Number(concurrency) || 1, items.length || 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function enrichWithDetails(items, config, headers, runtime) {
  const { source, currentUser } = config;
  if (!source.detailUrlTemplate || items.length === 0) return items;
  const idPath = source.detailIdPath || source.fields?.id || "id";

  return mapWithConcurrency(items, source.detailConcurrency ?? 4, async (item) => {
    const bugId = getByPath(item, idPath);
    if (bugId == null || bugId === "") {
      throw new Error(`详情补拉无法从列表项路径 ${idPath} 读取 Bug ID`);
    }
    const url = renderUrl(source.detailUrlTemplate, {
      baseUrl: String(source.baseUrl ?? "").replace(/\/+$/g, ""),
      currentUser,
      bugId,
      id: bugId,
    });
    try {
      const payload = await requestJson(
        url,
        {
          method: source.detailMethod || source.method || "GET",
          headers,
          retries: source.requestRetries,
          timeoutMs: source.requestTimeoutMs,
          retryDelayMs: source.retryDelayMs,
        },
        runtime,
      );
      const detail = source.detailResponsePath
        ? getByPath(payload, source.detailResponsePath)
        : payload;
      if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
        throw new Error("详情响应不是对象");
      }
      return { ...item, ...detail };
    } catch (error) {
      return {
        ...item,
        __fetchStatus: "detail_failed",
        __fetchError: sanitizeSourceError(error, `Bug ${bugId} 详情获取失败`),
      };
    }
  });
}

function zentaoApiBase(baseUrl) {
  const normalized = String(baseUrl).replace(/\/+$/g, "");
  return normalized.endsWith("/api.php/v1") ? normalized : `${normalized}/api.php/v1`;
}

async function zentaoRequestContext(config) {
  const { source } = config;
  let token = process.env[source.tokenEnv || "ZENTAO_TOKEN"];
  if (!token && source.tokenFile) {
    try {
      token = (await readFile(source.tokenFile, "utf8")).trim();
    } catch {
      throw new Error(`Token 文件不存在或不可读：${source.tokenFile}`);
    }
  }
  if (!token) {
    throw new Error(
      `缺少环境变量 ${source.tokenEnv || "ZENTAO_TOKEN"}，且未配置可读的 source.tokenFile`,
    );
  }
  return {
    apiBase: zentaoApiBase(source.baseUrl),
    headers: {
      "Content-Type": "application/json",
      ...interpolateEnvironment(source.headers ?? {}),
      Token: token,
    },
  };
}

function zentaoStatusCode(status) {
  if (status && typeof status === "object") {
    return String(status.code ?? status.value ?? status.name ?? "");
  }
  return printableValue(status);
}

function shouldKeepZentaoBug(bug, config) {
  const closedStatuses = new Set(
    (config.policy?.closedStatuses ?? ["closed", "已关闭"]).map((status) =>
      String(status).toLocaleLowerCase(),
    ),
  );
  if (closedStatuses.has(zentaoStatusCode(bug.status).toLocaleLowerCase())) return false;
  if (config.source.filterAssignedToCurrentUser === false) return true;
  const assignedTo = printableValue(bug.assignedTo).toLocaleLowerCase();
  return assignedTo === config.currentUser.toLocaleLowerCase();
}

async function loadZentaoProducts(config, apiBase, headers, runtime) {
  const { source } = config;
  const pageSize = Number(source.productPageSize ?? 100);
  const maxPages = Number(source.maxProductPages ?? 20);
  const products = [];
  let completed = false;

  for (let page = 1; page <= maxPages; page += 1) {
    const payload = await requestJson(
      `${apiBase}/products?limit=${pageSize}&page=${page}`,
      {
        headers,
        retries: source.requestRetries,
        timeoutMs: source.requestTimeoutMs,
        retryDelayMs: source.retryDelayMs,
      },
      runtime,
    );
    const pageProducts = payload.products;
    if (!Array.isArray(pageProducts)) {
      throw new Error("禅道 v1 产品列表响应中的 products 不是数组");
    }
    products.push(...pageProducts);
    const total = Number(payload.total);
    if ((Number.isFinite(total) && products.length >= total) || pageProducts.length < pageSize) {
      completed = true;
      break;
    }
  }
  if (!completed && source.allowTruncatedResults !== true) {
    throw new Error(
      `产品列表已达到 maxProductPages=${maxPages}，结果可能被截断；请提高上限或显式允许截断`,
    );
  }

  const selectedIds = source.productIds
    ? new Set(source.productIds.map((id) => String(id)))
    : undefined;
  return selectedIds
    ? products.filter((product) => selectedIds.has(String(product.id)))
    : products;
}

async function loadZentaoProductBugs(product, config, apiBase, headers, runtime) {
  const { source } = config;
  const pageSize = Number(source.pageSize ?? 100);
  const maxPages = Number(source.maxPagesPerProduct ?? 100);
  const bugs = [];
  let completed = false;

  for (let page = 1; page <= maxPages; page += 1) {
    const payload = await requestJson(
      `${apiBase}/products/${encodeURIComponent(String(product.id))}/bugs?limit=${pageSize}&page=${page}`,
      {
        headers,
        retries: source.requestRetries,
        timeoutMs: source.requestTimeoutMs,
        retryDelayMs: source.retryDelayMs,
      },
      runtime,
    );
    if (!Array.isArray(payload.bugs)) {
      throw new Error(`产品 ${product.id} 的 Bug 列表响应中的 bugs 不是数组`);
    }
    bugs.push(
      ...payload.bugs.map((bug) => ({
        ...bug,
        productName: product.name || String(product.id),
      })),
    );
    const total = Number(payload.total);
    if ((Number.isFinite(total) && bugs.length >= total) || payload.bugs.length < pageSize) {
      completed = true;
      break;
    }
  }
  if (!completed && source.allowTruncatedResults !== true) {
    throw new Error(
      `产品 ${product.id} 的 Bug 已达到 maxPagesPerProduct=${maxPages}，结果可能被截断`,
    );
  }
  return bugs.filter((bug) => shouldKeepZentaoBug(bug, config));
}

async function enrichZentaoBug(bug, product, config, apiBase, headers, runtime) {
  const responsePayload = await requestJson(
    `${apiBase}/bugs/${encodeURIComponent(String(bug.id))}`,
    {
      headers,
      retries: config.source.requestRetries,
      timeoutMs: config.source.requestTimeoutMs,
      retryDelayMs: config.source.retryDelayMs,
    },
    runtime,
  );
  const payload = responsePayload?.bug && typeof responsePayload.bug === "object"
    ? responsePayload.bug
    : responsePayload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`Bug ${bug.id} 详情响应不是对象`);
  }
  return {
    ...bug,
    ...payload,
    productName:
      product?.name ||
      bug.productName ||
      printableValue(payload.product) ||
      printableValue(bug.product),
    projectName: payload.projectName || bug.projectName || printableValue(payload.project),
    moduleName: payload.moduleName || bug.moduleName || printableValue(payload.module),
  };
}

async function loadZentaoProductScan(config, runtime) {
  const startedAt = Date.now();
  const { source } = config;
  const { apiBase, headers } = await zentaoRequestContext(config);
  if (!config.currentUser) {
    const userPayload = await requestJson(
      `${apiBase}/user`,
      {
        headers,
        retries: source.requestRetries,
        timeoutMs: source.requestTimeoutMs,
        retryDelayMs: source.retryDelayMs,
      },
      runtime,
    );
    const account = userPayload?.profile?.account;
    if (!account || typeof account !== "string") {
      throw new Error("禅道个人信息响应中没有 profile.account，无法识别当前账号");
    }
    config.currentUser = account;
  }
  runtime.progress?.("兼容模式：正在读取禅道产品列表");
  const products = await loadZentaoProducts(config, apiBase, headers, runtime);
  const productResults = await mapWithConcurrency(
    products,
    source.productConcurrency ?? 3,
    async (product) => {
      try {
        return {
          bugs: await loadZentaoProductBugs(product, config, apiBase, headers, runtime),
        };
      } catch (error) {
        if (isZentaoUnauthorized(error)) throw error;
        return {
          bugs: [],
          error: {
            scope: "product-bugs",
            productId: String(product.id),
            productName: printableValue(product.name),
            ...sanitizeSourceError(error, `产品 ${product.id} 的 Bug 列表获取失败`),
          },
        };
      }
    },
  );

  const candidates = productResults.flatMap((result) => result.bugs);
  const sourceErrors = productResults.flatMap((result) => result.error ? [result.error] : []);
  const productsById = new Map(products.map((product) => [String(product.id), product]));
  const items = await mapWithConcurrency(candidates, source.detailConcurrency ?? 4, async (bug) => {
    const product = productsById.get(String(bug.product)) || {
      id: bug.product,
      name: bug.productName,
    };
    try {
      return await enrichZentaoBug(bug, product, config, apiBase, headers, runtime);
    } catch (error) {
      if (isZentaoUnauthorized(error)) throw error;
      return {
        ...bug,
        __fetchStatus: "detail_failed",
        __fetchError: sanitizeSourceError(error, `Bug ${bug.id} 详情获取失败`),
      };
    }
  });
  return {
    items,
    sourceErrors,
    requestSummary: {
      listMode: "product-scan",
      productCount: products.length,
      personalCandidateCount: candidates.length,
      matchedBugCount: items.length,
      restApiRequests: runtime.requestCount ?? 0,
      retryCount: runtime.retryCount ?? 0,
    },
    timings: { totalMs: Date.now() - startedAt },
  };
}

async function loadZentaoAssignedToMe(config, runtime) {
  const startedAt = Date.now();
  const personal = await loadPersonalBugList(config, runtime.options);
  const candidates = personal.items.filter((bug) => shouldKeepZentaoBug(bug, config));
  const { apiBase, headers } = await zentaoRequestContext(config);
  const detailStartedAt = Date.now();
  let completedDetails = 0;
  const items = await mapWithConcurrency(
    candidates,
    config.source.detailConcurrency ?? 4,
    async (bug) => {
      try {
        return await enrichZentaoBug(bug, undefined, config, apiBase, headers, runtime);
      } catch (error) {
        if (isZentaoUnauthorized(error)) throw error;
        return {
          ...bug,
          __fetchStatus: "detail_failed",
          __fetchError: sanitizeSourceError(error, `Bug ${bug.id} 详情获取失败`),
        };
      } finally {
        completedDetails += 1;
        runtime.progress?.(`正在读取 Bug 详情 ${completedDetails}/${candidates.length}`);
      }
    },
  );
  const retainedItems = items.filter((bug) =>
    bug.__fetchStatus === "detail_failed" || shouldKeepZentaoBug(bug, config));
  const detailsMs = Date.now() - detailStartedAt;
  return {
    items: retainedItems,
    sourceErrors: [],
    requestSummary: {
      ...personal.requestSummary,
      matchedBugCount: retainedItems.length,
      detailRequests: candidates.length,
      restApiRequests: runtime.requestCount ?? 0,
      retryCount: runtime.retryCount ?? 0,
    },
    timings: {
      ...personal.timings,
      detailsMs,
      totalMs: Date.now() - startedAt,
    },
  };
}

async function loadZentaoV1(config, runtime) {
  if ((config.source.personalBugListMode || "assigned-to-me") === "product-scan") {
    return loadZentaoProductScan(config, runtime);
  }
  return loadZentaoAssignedToMe(config, runtime);
}

async function loadRest(config, runtime) {
  const startedAt = Date.now();
  const { source, currentUser } = config;
  const pageStart = Number(source.pageStart ?? 1);
  const pageSize = Number(source.pageSize ?? 100);
  const maxPages = Number(source.maxPages ?? 20);
  const headers = interpolateEnvironment(source.headers ?? {});
  const items = [];
  let completed = false;

  for (let offset = 0; offset < maxPages; offset += 1) {
    const page = pageStart + offset;
    const url = renderUrl(source.urlTemplate, {
      baseUrl: String(source.baseUrl ?? "").replace(/\/+$/g, ""),
      currentUser,
      page,
      pageSize,
    });
    const payload = await requestJson(
      url,
      {
        method: source.method || "GET",
        headers,
        retries: source.requestRetries,
        timeoutMs: source.requestTimeoutMs,
        retryDelayMs: source.retryDelayMs,
      },
      runtime,
    );
    const pageItems = getByPath(payload, source.responseItemsPath);
    if (!Array.isArray(pageItems)) {
      throw new Error(`REST 响应路径 ${source.responseItemsPath} 不是数组`);
    }
    items.push(...pageItems);

    const total = source.responseTotalPath
      ? Number(getByPath(payload, source.responseTotalPath))
      : undefined;
    if (Number.isFinite(total) && items.length >= total) {
      completed = true;
      break;
    }
    if (pageItems.length < pageSize) {
      completed = true;
      break;
    }
  }
  if (!completed && source.allowTruncatedResults !== true) {
    throw new Error(
      `已达到 maxPages=${maxPages}，结果可能被截断；请提高 maxPages、配置 responseTotalPath，或显式设置 allowTruncatedResults=true`,
    );
  }
  const enriched = await enrichWithDetails(items, config, headers, runtime);
  return {
    items: enriched,
    sourceErrors: [],
    requestSummary: {
      listMode: "rest",
      personalCandidateCount: items.length,
      matchedBugCount: enriched.length,
      restApiRequests: runtime.requestCount ?? 0,
      retryCount: runtime.retryCount ?? 0,
    },
    timings: { totalMs: Date.now() - startedAt },
  };
}

async function loadRawBugFromFixture(config, bugId) {
  const items = await loadFixture(config.source);
  const idPath = config.source.fields?.id || "id";
  const item = items.find((candidate) => String(getByPath(candidate, idPath)) === String(bugId));
  if (!item) throw new Error(`Fixture 中不存在 Bug ${bugId}`);
  return item;
}

async function loadRawRestBug(config, bugId, runtime) {
  const { source, currentUser } = config;
  if (!source.detailUrlTemplate) {
    throw new Error("REST 单 Bug 查询需要配置 source.detailUrlTemplate");
  }
  const headers = interpolateEnvironment(source.headers ?? {});
  const url = renderUrl(source.detailUrlTemplate, {
    baseUrl: String(source.baseUrl ?? "").replace(/\/+$/g, ""),
    currentUser,
    bugId,
    id: bugId,
  });
  const payload = await requestJson(
    url,
    {
      method: source.detailMethod || source.method || "GET",
      headers,
      retries: source.requestRetries,
      timeoutMs: source.requestTimeoutMs,
      retryDelayMs: source.retryDelayMs,
    },
    runtime,
  );
  const detail = source.detailResponsePath
    ? getByPath(payload, source.detailResponsePath)
    : payload;
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
    throw new Error("详情响应不是对象");
  }
  return detail;
}

async function loadRawZentaoBug(config, bugId, runtime) {
  const { apiBase, headers } = await zentaoRequestContext(config);
  const payload = await requestJson(
    `${apiBase}/bugs/${encodeURIComponent(String(bugId))}`,
    {
      headers,
      retries: config.source.requestRetries,
      timeoutMs: config.source.requestTimeoutMs,
      retryDelayMs: config.source.retryDelayMs,
    },
    runtime,
  );
  const detail = payload?.bug && typeof payload.bug === "object" ? payload.bug : payload;
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
    throw new Error(`Bug ${bugId} 详情响应不是对象`);
  }
  return detail;
}

export async function requestZentaoV1Token(
  { baseUrl, account, password, timeoutMs = 15_000 },
  options = {},
) {
  if (!baseUrl || !account || !password) {
    throw new Error("获取 Token 需要 baseUrl、account 和 password");
  }
  const runtime = {
    fetchImplementation: options.fetchImplementation ?? fetch,
    delayImplementation: options.delayImplementation ?? defaultDelay,
  };
  const payload = await requestJson(
    `${zentaoApiBase(baseUrl)}/tokens`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account, password }),
      retries: 0,
      timeoutMs,
      retryDelayMs: 0,
    },
    runtime,
  );
  if (!payload?.token || typeof payload.token !== "string") {
    throw new Error("禅道 Token 响应中没有有效的 token 字段");
  }
  return payload.token;
}

export function isZentaoUnauthorized(error) {
  return error?.status === 401;
}

function runtimeFromOptions(options) {
  return {
    fetchImplementation: options.fetchImplementation ?? fetch,
    delayImplementation: options.delayImplementation ?? defaultDelay,
    progress: options.onProgress,
    options,
    requestCount: 0,
    retryCount: 0,
  };
}

export async function loadRawBugsWithMetadata(config, options = {}) {
  if (config.source.type === "fixture") {
    const items = await loadFixture(config.source);
    return {
      items,
      sourceErrors: [],
      requestSummary: { listMode: "fixture", matchedBugCount: items.length },
      timings: { totalMs: 0 },
    };
  }
  const runtime = runtimeFromOptions(options);
  if (config.source.type === "zentao-v1") return loadZentaoV1(config, runtime);
  return loadRest(config, runtime);
}

export async function loadRawBugs(config, options = {}) {
  return (await loadRawBugsWithMetadata(config, options)).items;
}

export async function loadRawBugById(config, bugId, options = {}) {
  if (config.source.type === "fixture") return loadRawBugFromFixture(config, bugId);
  const runtime = runtimeFromOptions(options);
  if (config.source.type === "zentao-v1") {
    return loadRawZentaoBug(config, bugId, runtime);
  }
  return loadRawRestBug(config, bugId, runtime);
}

export async function fetchBinary(url, requestOptions, options = {}) {
  const runtime = runtimeFromOptions(options);
  const retries = Number(requestOptions.retries ?? 0);
  const timeoutMs = Number(requestOptions.timeoutMs ?? 15_000);
  const retryDelayMs = Number(requestOptions.retryDelayMs ?? 300);
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await runtime.fetchImplementation(url, {
        method: "GET",
        headers: requestOptions.headers,
        signal: controller.signal,
        redirect: requestOptions.redirect || "manual",
      });
      if (response.status >= 300 && response.status < 400) return response;
      if (!response.ok) {
        const error = new Error(`禅道请求失败：HTTP ${response.status}`);
        error.status = response.status;
        error.retryAfterMs = retryAfterMilliseconds(response);
        if (!shouldRetryStatus(response.status) || attempt === retries) throw error;
        lastError = error;
      } else {
        return response;
      }
    } catch (error) {
      const retryable =
        error.name === "AbortError" ||
        error.name === "TypeError" ||
        /HTTP (408|429|5\d\d)/.test(error.message);
      if (!retryable || attempt === retries) {
        if (error.name === "AbortError") {
          const timeoutError = new Error(`禅道请求超时（${timeoutMs}ms）`);
          timeoutError.code = "REQUEST_TIMEOUT";
          throw timeoutError;
        }
        throw error;
      }
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }
    const exponentialDelay = Math.min(retryDelayMs * (2 ** attempt), 30_000);
    await runtime.delayImplementation(lastError?.retryAfterMs ?? exponentialDelay);
  }
  throw lastError || new Error("禅道请求失败");
}
