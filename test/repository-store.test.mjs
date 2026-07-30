import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { storeRepositoryByProject } from "../plugins/one-click-repair/skills/zentao-frontend-bugfix/scripts/lib/repository-store.mjs";

test("用户提供仓库后按评论中的所属项目持久化并可重复更新", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bugfix-repository-store-"));
  try {
    const configPath = path.join(directory, "config.json");
    const firstRepo = path.join(directory, "repo-a");
    const secondRepo = path.join(directory, "repo-b");
    await mkdir(firstRepo);
    await mkdir(secondRepo);
    await writeFile(configPath, '{"repositoriesByProject":{}}\n', { mode: 0o600 });

    await storeRepositoryByProject(configPath, "Example-React", firstRepo);
    await storeRepositoryByProject(configPath, "example-react", secondRepo);

    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(config.repositoriesByProject, { "example-react": secondRepo });
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
