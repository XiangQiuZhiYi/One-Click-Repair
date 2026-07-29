#!/usr/bin/env node

import process from "node:process";

import { installSkill } from "./bootstrap.mjs";

installSkill()
  .then((result) => {
    console.log(
      JSON.stringify(
        {
          ok: true,
          skillPath: result.targetPath,
          previousSkillBackup: result.backupPath,
          message: "Skill 已更新。请完全退出并重新打开 Codex。",
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
