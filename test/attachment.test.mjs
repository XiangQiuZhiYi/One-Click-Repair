import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { downloadBugImage } from "../plugins/one-click-repair/skills/zentao-frontend-bugfix/scripts/lib/attachment.mjs";
import { getZentaoBugAttachment } from "../plugins/one-click-repair/scripts/mcp-server.mjs";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

function restConfig(overrides = {}) {
  return {
    source: {
      type: "rest",
      baseUrl: "https://zentao.example.com/zentao",
      requestRetries: 0,
      maxAttachmentBytes: 1024,
      ...overrides,
    },
  };
}

test("图片附件拒绝跨域、跨域重定向、伪造类型和超限内容", async () => {
  await assert.rejects(
    downloadBugImage(
      restConfig(),
      "1",
      { id: "1", name: "screen.png", url: "https://evil.example/screen.png" },
      { fetchImplementation: async () => new Response(png) },
    ),
    /不同源/,
  );

  await assert.rejects(
    downloadBugImage(
      restConfig(),
      "1",
      { id: "1", name: "screen.png", url: "/zentao/redirect" },
      {
        fetchImplementation: async () =>
          new Response(null, {
            status: 302,
            headers: { Location: "https://evil.example/screen.png" },
          }),
      },
    ),
    /不同源/,
  );

  await assert.rejects(
    downloadBugImage(
      restConfig(),
      "1",
      { id: "1", name: "screen.png", url: "/zentao/screen.png" },
      {
        fetchImplementation: async () =>
          new Response("<svg></svg>", { headers: { "Content-Type": "image/svg+xml" } }),
      },
    ),
    /不是受支持/,
  );

  await assert.rejects(
    downloadBugImage(
      restConfig({ maxAttachmentBytes: 8 }),
      "1",
      { id: "1", name: "screen.png", url: "/zentao/screen.png" },
      {
        fetchImplementation: async () =>
          new Response(png, { headers: { "Content-Type": "image/png" } }),
      },
    ),
    /超过大小限制/,
  );

  await assert.rejects(
    downloadBugImage(
      restConfig(),
      "1",
      { id: "1", name: "screen.jpg", url: "/zentao/screen.jpg" },
      {
        fetchImplementation: async () =>
          new Response(png, { headers: { "Content-Type": "image/png" } }),
      },
    ),
    /扩展名与实际图片内容不一致/,
  );
});

test("同主机内联 HTTP 图片按配置安全升级为 HTTPS", async () => {
  let requestedUrl;
  const result = await downloadBugImage(
    restConfig(),
    "1",
    {
      id: "88",
      name: "screen.png",
      url: "http://zentao.example.com/zentao/file-read-88.png",
    },
    {
      fetchImplementation: async (url) => {
        requestedUrl = url;
        return new Response(png, { headers: { "Content-Type": "image/png" } });
      },
    },
  );
  assert.equal(requestedUrl, "https://zentao.example.com/zentao/file-read-88.png");
  assert.equal(result.metadata.mimeType, "image/png");

  await assert.rejects(
    downloadBugImage(
      restConfig(),
      "1",
      {
        id: "89",
        name: "screen.png",
        url: "http://evil.example/zentao/file-read-89.png",
      },
      { fetchImplementation: async () => new Response(png) },
    ),
    /不同源/,
  );
});

test("图片附件 401 后只刷新一次 Token 且不在元数据中泄露内容", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bugfix-attachment-token-"));
  try {
    const tokenFile = path.join(directory, "token");
    const configFile = path.join(directory, "config.json");
    const outputDir = path.join(directory, "output");
    const reportPath = path.join(outputDir, "triage.json");
    await mkdir(outputDir, { recursive: true });
    await writeFile(tokenFile, "old-token\n");
    await writeFile(
      configFile,
      JSON.stringify({
        currentUser: "me",
        source: {
          type: "zentao-v1",
          baseUrl: "https://zentao.example.com/zentao",
          tokenEnv: "UNSET_ATTACHMENT_TOKEN",
          tokenFile,
          accountFile: path.join(directory, "account"),
          requestRetries: 0,
        },
        outputDir,
      }),
    );
    await writeFile(
      reportPath,
      JSON.stringify({
        schemaVersion: 2,
        items: [
          {
            bug: {
              id: "901",
              attachments: [
                { id: "10", name: "screen.png", url: "/zentao/files/10" },
              ],
            },
          },
        ],
      }),
    );
    const observedTokens = [];
    let refreshCount = 0;
    const result = await getZentaoBugAttachment(
      {
        config_path: configFile,
        report_path: reportPath,
        bug_id: "901",
        attachment_id: "10",
      },
      {
        ensureToken: async () => ({ ready: true }),
        withTokenRefresh: async (_config, operation) => {
          try {
            return { value: await operation(), tokenAutoRefreshed: false };
          } catch (error) {
            assert.equal(error.status, 401);
            refreshCount += 1;
            await writeFile(tokenFile, "new-token\n");
            return { value: await operation(), tokenAutoRefreshed: true };
          }
        },
        fetchImplementation: async (_url, init) => {
          observedTokens.push(init.headers.Token);
          if (init.headers.Token === "old-token") {
            return new Response("unauthorized", { status: 401 });
          }
          return new Response(png, { headers: { "Content-Type": "image/png" } });
        },
      },
    );
    assert.equal(refreshCount, 1);
    assert.deepEqual(observedTokens, ["old-token", "new-token"]);
    assert.equal(result.tokenAutoRefreshed, true);
    assert.equal("data" in result.metadata, false);
    assert.doesNotMatch(JSON.stringify(result.metadata), /old-token|new-token/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
