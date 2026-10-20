import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { it } from "node:test";

// Regression guard for a clean-clone bug: better-sqlite3 13 ships prebuilt binaries but has
// a binding.gyp and no install script. When npm installs it from package-lock.json, it runs
// "node-gyp rebuild" anyway, which fails on machines without a C++ compiler. Version 12 has
// an explicit install script (prebuild-install downloads a prebuilt binary), which npm
// records in the lockfile, so `npm install` works from a fresh clone.
it("locks a better-sqlite3 version that installs without a C++ compiler", () => {
  const lockPath = path.resolve(import.meta.dirname, "../../package-lock.json");
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8")) as {
    packages: Record<string, { version?: string; hasInstallScript?: boolean }>;
  };
  const entry = lock.packages["server/node_modules/better-sqlite3"] ?? lock.packages["node_modules/better-sqlite3"];
  assert.ok(entry?.version, "better-sqlite3 is in the lockfile");
  assert.equal(entry.version.split(".")[0], "12");
  assert.equal(entry.hasInstallScript, true);
});
