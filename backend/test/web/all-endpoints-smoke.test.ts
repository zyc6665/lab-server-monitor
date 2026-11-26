import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import request from "supertest";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("../../src/storage/dpapi", () => ({
  dpapiAvailable: () => true,
  protect: (b: Buffer) => Buffer.from(b),
  unprotect: (b: Buffer) => Buffer.from(b),
  DpapiUnavailableError: class extends Error {},
}));

import { loadConfig } from "../../src/config/config";
import { listHosts } from "../../src/config/hosts";
import { setAdminPassword } from "../../src/web/routes/auth";
import { createServerApp } from "../../src/web/composition";
import { openDatabase } from "../../src/storage/db";
import { ENDPOINTS } from "../../src/web/routes/registry";

const PASSWORD = "admin-pass-123";

function cookieFrom(res: {
  headers: Record<string, string | string[] | undefined>;
}): string {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const c = list
    .map((e) => e.split(";")[0])
    .filter((e) => e.startsWith("servermonitor_session="))
    .pop();
  if (!c) throw new Error("no session cookie");
  return c;
}

describe("all GET endpoints smoke (seed DB)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "smoke-"));
  afterAll(() => {
    try {
      rmSync(dir, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 100,
      });
    } catch {
      /* Windows may still hold a WAL handle; a leftover temp dir is harmless. */
    }
  });

  it("every page and GET api responds without a 5xx", async () => {
    const dbPath = path.join(dir, "servermonitor.db");
    copyFileSync(
      path.join(__dirname, "../fixtures/seed/servermonitor-seed.db"),
      dbPath,
    );
    const db = openDatabase(dbPath);
    try {
      await runSmoke(db);
    } finally {
      db.close();
    }
  }, 120000);

  async function runSmoke(db: ReturnType<typeof openDatabase>): Promise<void> {
    setAdminPassword(db, { newPassword: PASSWORD, username: "admin" });
    const config = loadConfig({
      SERVERMONITOR_DATA_DIR: dir,
      SERVERMONITOR_APP_VERSION: "test",
    });
    const app = createServerApp({ db, config });
    const login = await request(app)
      .post("/login")
      .type("form")
      .send({ username: "admin", password: PASSWORD });
    const cookie = cookieFrom(login);
    const home = await request(app).get("/").set("Cookie", cookie);
    const csrf =
      /name="csrf-token" content="([^"]+)"/.exec(home.text)?.[1] ?? "";
    const hosts = listHosts(db);
    const hostName = hosts[0]?.name ?? "none";

    const skip = new Set([
      "setup",
      "login",
      "login_submit",
      "logout",
      "api_change_password",
      "terminal_page",
    ]);
    const problems: string[] = [];
    for (const [name, tpl] of Object.entries(ENDPOINTS)) {
      if (skip.has(name)) continue;
      if (tpl.includes("{alert_id}") || tpl.includes("{silence_id}")) continue;
      const url = tpl.replace("{name}", encodeURIComponent(hostName));
      const res = await request(app).get(url).set("Cookie", cookie);
      if (res.status >= 500) problems.push(`${name} ${url} -> ${res.status}`);
    }
    console.log("SMOKE problems:", JSON.stringify(problems));
    expect(problems).toEqual([]);
  }
});
