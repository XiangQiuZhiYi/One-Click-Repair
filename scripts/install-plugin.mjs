#!/usr/bin/env node

import { installLocalPlugin } from "./plugin-manager.mjs";
import { retireLegacySkill } from "./bootstrap.mjs";

installLocalPlugin()
  .then(async (result) => {
    const legacy = await retireLegacySkill();
    console.log(
      JSON.stringify(
        {
          ok: true,
          ...result,
          previousSkillBackup: legacy.backupPath,
          message: "Plugin 已安装或更新。请完全退出并重新打开 Codex。",
        },
        null,
        2,
      ),
    );
  })
  .catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exitCode = 1;
  });
