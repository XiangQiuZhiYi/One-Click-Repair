import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { storeRepositoryByExecution } from "../skills/zentao-frontend-bugfix/scripts/lib/repository-store.mjs";

test("用户提供仓库后按所属执行 key 持久化并可重复更新", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bugfix-repository-store-"));
  try {
    const configPath = path.join(directory, "config.json");
    const firstRepo = path.join(directory, "repo-a");
    const secondRepo = path.join(directory, "repo-b");
    await mkdir(firstRepo);
    await mkdir(secondRepo);
    await writeFile(configPath, '{"repositoriesByExecution":{}}\n', { mode: 0o600 });

    await storeRepositoryByExecution(configPath, "2640", firstRepo);
    await storeRepositoryByExecution(configPath, "2640", secondRepo);

    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(config.repositoriesByExecution, { "2640": secondRepo });
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
