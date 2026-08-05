import { readFile } from "node:fs/promises";
import { readKeychainPassword } from "./keychain.mjs";

const DEFAULT_LIST_PATH = "my-work-bug-assignedTo--id_desc.html";

function webBaseUrl(baseUrl) {
  return String(baseUrl || "")
    .replace(/\/+$/u, "")
    .replace(/\/api\.php\/v1$/u, "");
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&quot;/giu, "\"")
    .replace(/&apos;|&#0*39;|&#x0*27;/giu, "'")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&amp;/giu, "&")
    .replace(/&#(\d+);/gu, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/giu, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function sameOriginUrl(value, base, label) {
  const url = new URL(value, base);
  if (url.origin !== new URL(base).origin) {
    throw new Error(`${label}不是禅道同源地址，已拒绝访问`);
  }
  return url;
}

function extractAttribute(html, attributeName) {
  const marker = `${attributeName}=`;
  const start = html.toLocaleLowerCase().indexOf(marker.toLocaleLowerCase());
  if (start < 0) return undefined;
  const quoteIndex = start + marker.length;
  const quote = html[quoteIndex];
  if (quote !== "\"" && quote !== "'") return undefined;
  const end = html.indexOf(quote, quoteIndex + 1);
  if (end < 0) return undefined;
  return decodeHtmlEntities(html.slice(quoteIndex + 1, end));
}

function findBalancedJsonArray(source, start) {
  let depth = 0;
  let quote;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (character === "[") depth += 1;
    if (character === "]") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error("禅道个人 Bug 列表中的 data 数组不完整");
}

function parseDataArray(configText) {
  const pattern = /(?:^|[,{])\s*["']?data["']?\s*:\s*(?=\[)/gu;
  for (const match of configText.matchAll(pattern)) {
    const start = match.index + match[0].length;
    try {
      const value = JSON.parse(findBalancedJsonArray(configText, start));
      if (Array.isArray(value)) return value;
    } catch {
      // The outer component configuration can contain JavaScript. Only accept a pure JSON array.
    }
  }
  throw new Error("禅道个人 Bug 页面中没有可安全读取的 data 数组");
}

function parseNumberProperty(configText, name) {
  const match = configText.match(new RegExp(`["']?${name}["']?\\s*:\\s*([0-9]+)`, "u"));
  return match ? Number(match[1]) : undefined;
}

function parseStringProperty(configText, name) {
  const match = configText.match(new RegExp(`["']?${name}["']?\\s*:\\s*(["'])(.*?)\\1`, "u"));
  if (!match) return undefined;
  if (match[1] === "\"") {
    try {
      return JSON.parse(`"${match[2]}"`);
    } catch {
      return match[2];
    }
  }
  return match[2].replace(/\\'/gu, "'").replace(/\\\\/gu, "\\");
}

export function parsePersonalBugPage(html) {
  const componentConfig = extractAttribute(html, "zui-create-dtable");
  if (!componentConfig) {
    throw new Error("禅道个人 Bug 页面缺少列表组件，登录可能已失效或页面结构不兼容");
  }
  return {
    items: parseDataArray(componentConfig),
    total: parseNumberProperty(componentConfig, "recTotal"),
    pageSize: parseNumberProperty(componentConfig, "recPerPage"),
    page: parseNumberProperty(componentConfig, "page"),
    linkCreator: parseStringProperty(componentConfig, "linkCreator"),
  };
}

function collectCookies(response, cookies) {
  const values = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean);
  for (const value of values) {
    const pair = String(value).split(";", 1)[0];
    const separator = pair.indexOf("=");
    if (separator > 0) cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
}

function cookieHeader(cookies) {
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function fetchText(url, init, runtime) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), runtime.timeoutMs);
  try {
    const response = await runtime.fetchImplementation(url, {
      ...init,
      redirect: "manual",
      signal: controller.signal,
    });
    collectCookies(response, runtime.cookies);
    return { response, text: await response.text() };
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error(`禅道个人 Bug 列表请求超时（${runtime.timeoutMs}ms）`);
      timeoutError.code = "REQUEST_TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function parseLoginForm(html, pageUrl) {
  const form = html.match(/<form\b[^>]*\baction=["']([^"']+)["'][^>]*>/iu);
  if (!form) throw new Error("禅道登录页缺少可识别的登录表单，请重新执行 setup 或配置兼容模式");
  const inputs = [...html.matchAll(/<input\b[^>]*>/giu)].map((match) => match[0]);
  const names = new Set(inputs.flatMap((input) => {
    const name = input.match(/\bname=["']([^"']+)["']/iu)?.[1];
    return name ? [name] : [];
  }));
  if ([...names].some((name) => /captcha|verify|code/iu.test(name))) {
    throw new Error("禅道登录启用了验证码，无法进行无交互自动登录");
  }
  if (!names.has("account") || !names.has("password")) {
    throw new Error("禅道登录表单字段不兼容，无法安全自动登录");
  }
  return sameOriginUrl(decodeHtmlEntities(form[1]), pageUrl, "禅道登录表单");
}

async function readAccount(config) {
  if (config.currentUser?.trim()) return config.currentUser.trim();
  if (config.source.accountFile) {
    try {
      const account = (await readFile(config.source.accountFile, "utf8")).trim();
      if (account) return account;
    } catch {
      // Setup status is reported below without exposing the credential path or contents.
    }
  }
  const error = new Error("尚未初始化禅道账号，请先运行 npx one-click-repair@latest setup");
  error.code = "ZENTAO_SETUP_REQUIRED";
  throw error;
}

async function openAuthenticatedList(targetUrl, account, config, runtime) {
  const startedAt = Date.now();
  runtime.progress?.("正在建立禅道个人会话");
  let result = await fetchText(targetUrl, { headers: {} }, runtime);
  try {
    const parsed = parsePersonalBugPage(result.text);
    return { parsed, authenticationMs: Date.now() - startedAt, webLoginRequests: 0 };
  } catch {
    // A fresh MCP process normally has no web session, so continue through the login page.
  }

  const location = result.response.headers.get("location");
  if (!location) {
    throw new Error("禅道个人 Bug 页面未返回列表或登录入口，请重新执行 setup");
  }
  const loginUrl = sameOriginUrl(location, targetUrl, "禅道登录跳转");
  const loginPage = await fetchText(loginUrl, {
    headers: runtime.cookies.size ? { Cookie: cookieHeader(runtime.cookies) } : {},
  }, runtime);
  const formUrl = parseLoginForm(loginPage.text, loginUrl);
  const password = await runtime.readPassword(
    { baseUrl: config.source.baseUrl, account },
    runtime.keychainOptions,
  );
  const body = new URLSearchParams({
    account,
    password,
    keepLogin: "1",
    referer: targetUrl.href,
  });
  const loginResponse = await fetchText(formUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(runtime.cookies.size ? { Cookie: cookieHeader(runtime.cookies) } : {}),
    },
    body,
  }, runtime);
  if (loginResponse.response.status === 401 || loginResponse.response.status === 403) {
    const error = new Error("钥匙串中的禅道账号或密码已失效，请重新运行 setup");
    error.code = "ZENTAO_CREDENTIAL_INVALID";
    throw error;
  }
  result = await fetchText(targetUrl, {
    headers: runtime.cookies.size ? { Cookie: cookieHeader(runtime.cookies) } : {},
  }, runtime);
  let parsed;
  try {
    parsed = parsePersonalBugPage(result.text);
  } catch (cause) {
    const error = new Error("禅道登录后仍无法读取个人 Bug 列表，请检查账号密码或页面兼容性", { cause });
    error.code = "ZENTAO_CREDENTIAL_INVALID";
    throw error;
  }
  return { parsed, authenticationMs: Date.now() - startedAt, webLoginRequests: 4 };
}

function pageUrlFromTemplate(linkCreator, targetUrl, pageSize, page) {
  if (!linkCreator) return undefined;
  const rendered = linkCreator
    .replaceAll("{recPerPage}", String(pageSize))
    .replaceAll("{page}", String(page));
  return sameOriginUrl(rendered, targetUrl, "禅道个人 Bug 分页链接");
}

export async function loadPersonalBugList(config, options = {}) {
  const source = config.source;
  const account = await readAccount(config);
  config.currentUser = account;
  const baseUrl = webBaseUrl(source.baseUrl);
  const targetUrl = sameOriginUrl(
    source.personalBugListPath || DEFAULT_LIST_PATH,
    `${baseUrl}/`,
    "禅道个人 Bug 列表",
  );
  const runtime = {
    fetchImplementation: options.fetchImplementation ?? fetch,
    readPassword: options.readKeychainPassword ?? readKeychainPassword,
    keychainOptions: options.keychainOptions,
    progress: options.onProgress,
    timeoutMs: Number(source.requestTimeoutMs ?? 15_000),
    cookies: new Map(),
  };
  const totalStartedAt = Date.now();
  const authenticated = await openAuthenticatedList(targetUrl, account, config, runtime);
  let items = [...authenticated.parsed.items];
  const total = authenticated.parsed.total;
  const requestedPageSize = Math.min(Number(source.personalBugPageSize ?? 100), 1_000);
  const maxPages = Number(source.maxPersonalBugPages ?? 20);
  let pages = 1;

  if (Number.isFinite(total) && items.length < total) {
    if (!authenticated.parsed.linkCreator) {
      throw new Error("禅道个人 Bug 数量超过当前页，但页面缺少分页链接");
    }
    if (authenticated.parsed.pageSize !== requestedPageSize) {
      runtime.progress?.(`正在将个人 Bug 每页数量调整为 ${requestedPageSize}`);
      const firstPageUrl = pageUrlFromTemplate(
        authenticated.parsed.linkCreator,
        targetUrl,
        requestedPageSize,
        1,
      );
      const firstPage = await fetchText(firstPageUrl, {
        headers: runtime.cookies.size ? { Cookie: cookieHeader(runtime.cookies) } : {},
      }, runtime);
      items = [...parsePersonalBugPage(firstPage.text).items];
      pages += 1;
    }
    const expectedPages = Math.ceil(total / requestedPageSize);
    for (let page = 2; page <= expectedPages && page <= maxPages; page += 1) {
      runtime.progress?.(`正在读取个人 Bug 列表 ${page}/${expectedPages}`);
      const pageUrl = pageUrlFromTemplate(
        authenticated.parsed.linkCreator,
        targetUrl,
        requestedPageSize,
        page,
      );
      const result = await fetchText(pageUrl, {
        headers: runtime.cookies.size ? { Cookie: cookieHeader(runtime.cookies) } : {},
      }, runtime);
      items.push(...parsePersonalBugPage(result.text).items);
      pages += 1;
    }
    if (items.length < total && source.allowTruncatedResults !== true) {
      throw new Error(
        `个人 Bug 列表已达到 maxPersonalBugPages=${maxPages}，结果可能被截断`,
      );
    }
  }

  const uniqueItems = [...new Map(items.map((item) => [String(item.id), item])).values()];
  runtime.progress?.(`个人 Bug 列表读取完成：${uniqueItems.length} 条`);
  return {
    account,
    items: uniqueItems,
    requestSummary: {
      listMode: "assigned-to-me",
      webLoginRequests: authenticated.webLoginRequests,
      personalListPages: pages,
      personalCandidateCount: uniqueItems.length,
    },
    timings: {
      authenticationMs: authenticated.authenticationMs,
      personalListMs: Date.now() - totalStartedAt,
    },
  };
}
