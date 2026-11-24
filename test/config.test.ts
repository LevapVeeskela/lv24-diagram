import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { ConfigError, loadConfig } from "../src/config.js";

interface Fixture {
  dir: string;
  configPath: string;
  passwordPath: string;
}

async function fixture(passwordFile: string, password = "inline-ignored"): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "lv24-diagram-config-"));
  const configPath = join(dir, "diagram.config.json");
  const passwordPath = join(dir, "db-password");
  const config = {
    database: {
      kind: "postgres",
      host: "127.0.0.1",
      port: 5432,
      database: "app",
      user: "readonly_user",
      password,
      passwordFile,
    },
  };
  await writeFile(configPath, JSON.stringify(config), "utf8");
  return { dir, configPath, passwordPath };
}

test("passwordFile is read, trimmed and wins over an inline password", async () => {
  const { dir, configPath, passwordPath } = await fixture("db-password");
  try {
    await writeFile(passwordPath, "  s3cret-from-file\n", "utf8");
    const config = await loadConfig({ path: configPath });
    assert.ok(config.database);
    assert.equal(config.database.password, "s3cret-from-file");
    assert.equal(config.database.passwordFile, resolve(passwordPath));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("relative passwordFile resolves against the config directory, not cwd", async () => {
  const { dir, configPath, passwordPath } = await fixture("db-password");
  const otherCwd = await mkdtemp(join(tmpdir(), "lv24-diagram-cwd-"));
  try {
    await writeFile(passwordPath, "from-config-dir\n", "utf8");
    await writeFile(join(otherCwd, "db-password"), "wrong-cwd\n", "utf8");
    const config = await loadConfig({ path: configPath, cwd: otherCwd });
    assert.equal(config.database?.password, "from-config-dir");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(otherCwd, { recursive: true, force: true });
  }
});

test("missing passwordFile fails with the path and no password contents", async () => {
  const { dir, configPath, passwordPath } = await fixture("db-password", "inline-secret-value");
  try {
    await assert.rejects(loadConfig({ path: configPath }), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /database\.passwordFile not found/);
      assert.ok(error.message.includes(resolve(passwordPath)), "error names the resolved path");
      assert.doesNotMatch(error.message, /inline-secret-value/);
      return true;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("empty passwordFile is a config error, not an empty password", async () => {
  const { dir, configPath, passwordPath } = await fixture("db-password");
  try {
    await writeFile(passwordPath, " \n\t\n", "utf8");
    await assert.rejects(loadConfig({ path: configPath }), /database\.passwordFile is empty/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("config without passwordFile keeps the inline password", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lv24-diagram-config-"));
  try {
    const configPath = join(dir, "diagram.config.json");
    await writeFile(
      configPath,
      JSON.stringify({ database: { database: "app", user: "u", password: "inline-only" } }),
      "utf8",
    );
    const config = await loadConfig({ path: configPath });
    assert.equal(config.database?.password, "inline-only");
    assert.equal(config.database?.passwordFile, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
