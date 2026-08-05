import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

export async function readJson(filePath) {
  const text = await readFile(filePath, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`无法解析 JSON：${filePath}（${error.message}）`);
  }
}

export async function ensurePrivateDirectory(directoryPath) {
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  await chmod(directoryPath, 0o700);
  return directoryPath;
}

export async function secureAtomicWrite(filePath, value, encoding = "utf8") {
  const directoryPath = path.dirname(filePath);
  await ensurePrivateDirectory(directoryPath);
  const temporaryPath = path.join(
    directoryPath,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, value, {
      encoding,
      mode: 0o600,
      flag: "wx",
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return filePath;
}

export async function writeJson(filePath, value) {
  return secureAtomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function resolvePath(baseDir, value) {
  if (!value) return undefined;
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(baseDir, value);
}

export function getByPath(value, dottedPath) {
  if (!dottedPath) return value;
  return String(dottedPath)
    .split(".")
    .filter(Boolean)
    .reduce((current, key) => (current == null ? undefined : current[key]), value);
}

export function printableValue(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) return value.map(printableValue).filter(Boolean).join(", ");
  for (const key of ["name", "title", "account", "realname", "value", "id"]) {
    if (value[key] != null) return printableValue(value[key]);
  }
  return JSON.stringify(value);
}

export function stripHtml(value) {
  return printableValue(value)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function interpolateEnvironment(value, environment = process.env) {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name) => {
      const resolved = environment[name];
      if (!resolved) throw new Error(`缺少环境变量：${name}`);
      return resolved;
    });
  }
  if (Array.isArray(value)) return value.map((item) => interpolateEnvironment(item, environment));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, interpolateEnvironment(item, environment)]),
    );
  }
  return value;
}

export function wildcardMatches(actual, candidates) {
  if (candidates == null) return true;
  const patterns = Array.isArray(candidates) ? candidates : [candidates];
  if (patterns.length === 0) return true;
  const normalizedActual = printableValue(actual).toLocaleLowerCase();
  return patterns.some((pattern) => {
    const normalizedPattern = printableValue(pattern).toLocaleLowerCase();
    const expression = normalizedPattern
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    return new RegExp(`^${expression}$`, "u").test(normalizedActual);
  });
}

export function slugify(value, fallback = "task") {
  const slug = stripHtml(value)
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || fallback;
}

export function truncate(value, limit = 20_000) {
  const text = printableValue(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…（输出已截断）`;
}

export function markdownCell(value) {
  return printableValue(value).replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}
