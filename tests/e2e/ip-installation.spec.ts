import { createServer, request as httpRequest, type Server } from "node:http";
import { networkInterfaces } from "node:os";
import { expect, type Page, test } from "@playwright/test";

const address = Object.values(networkInterfaces())
  .flat()
  .find((entry) => entry?.family === "IPv4" && !entry.internal)?.address;
if (!address) throw new Error("IP installation tests require a non-loopback IPv4 interface");
const ipOrigin = `http://${address}:23111`;
const cookieName = "xhs_admin_refresh";
const password = "Example-password123";
let initialized = false;
let refreshes = 0;
const settings = new Map<string, string | boolean>();
const requests: string[] = [];
const writes: {
  path: string;
  cookie: string;
  idempotency: string;
  body: Record<string, unknown>;
}[] = [];
let api: Server;
let proxy: Server;

const profile = {
  userId: "owner",
  username: "owner",
  name: "示例管理员",
  phone: null,
  audience: "xhs-saas-admin",
  sessionId: "session",
  scopes: [
    {
      scopeType: "PLATFORM",
      scopeId: "platform",
      role: { code: "PLATFORM_ADMIN", name: "系统管理员" },
      permissions: ["platform.settings.manage", "platform.monitor.read"],
      inheritedEnterprises: [],
    },
    {
      scopeType: "ENTERPRISE",
      scopeId: "enterprise",
      tenant: { id: "tenant", name: "示例企业", customerType: "SINGLE_ENTERPRISE" },
      enterprise: { id: "enterprise", name: "示例企业" },
      role: { code: "ENTERPRISE_ADMIN", name: "企业管理员" },
      permissions: ["enterprise.membership.read"],
      inheritedEnterprises: [],
    },
  ],
};

const task = {
  id: "task",
  status: "AVAILABLE",
  campaign: { id: "campaign", title: "真实图文任务" },
  enterprise: { id: "enterprise", name: "示例企业" },
  contentVisible: true,
  contentRevision: 1,
  factsConfirmationRequired: true,
  factsConfirmed: false,
  factsReturned: false,
  visibleAt: "2026-01-01T00:00:00Z",
  expiresAt: "2030-01-01T00:00:00Z",
  content: {
    title: "今天的门店记录",
    body: "这是我确认过的真实记录。",
    hashtags: ["工作日常"],
    images: [],
  },
};

async function listen(server: Server, port: number) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

async function close(server: Server | undefined) {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test.beforeAll(async () => {
  // Only the business API is simulated. Browser requests pass through the real Next gateway.
  api = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const source = Buffer.concat(chunks).toString("utf8");
    const body = source ? JSON.parse(source) : {};
    const path = new URL(request.url ?? "/", "http://upstream.example.test").pathname;
    requests.push(path);
    const method = request.method ?? "GET";
    const cookie = request.headers.cookie ?? "";
    const json = (value: unknown, status = 200) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    const setCookie = (clear = false) =>
      response.setHeader(
        "set-cookie",
        `${cookieName}=${clear ? "" : "fixture-refresh-cookie"}; Path=/auth/admin; HttpOnly; SameSite=Strict; Secure; Max-Age=${clear ? 0 : 3600}`,
      );
    if (method === "POST") {
      const idempotency = String(request.headers["idempotency-key"] ?? "");
      writes.push({ path, body, cookie, idempotency });
      if (
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(idempotency)
      )
        return json({ message: "A secure UUID idempotency key is required" }, 400);
    }
    if (path === "/public/platform-branding")
      return json({ name: "示例管理平台", logoDataUrl: null });
    if (path === "/auth/admin/installation") {
      if (method === "GET") return json({ initialized });
      if (initialized) return json({ message: "已完成安装" }, 409);
      initialized = true;
      settings.set("storage.provider", "LOCAL");
      setCookie();
      return json({ accessToken: "fixture-access", expiresInSeconds: 3600 }, 201);
    }
    if (path === "/auth/admin/refresh") {
      if (!cookie.includes(`${cookieName}=fixture-refresh-cookie`))
        return json({ message: "missing refresh cookie" }, 401);
      refreshes++;
      setCookie();
      return json({ accessToken: `fixture-refreshed-${refreshes}`, expiresInSeconds: 3600 });
    }
    if (path === "/auth/admin/password-login") {
      if (body.password !== password) return json({ message: "账号或密码不正确" }, 401);
      setCookie();
      return json({ accessToken: "fixture-login", expiresInSeconds: 3600 });
    }
    if (path === "/auth/admin/logout") {
      setCookie(true);
      response.writeHead(204);
      return response.end();
    }
    if (path === "/auth/admin/session") return json(profile);
    if (path === "/auth/captcha/password-challenge") return json({ required: false });
    if (path === "/auth/employee/web-session")
      return json({ accessToken: "fixture-employee", expiresInSeconds: 3600 });
    if (path === "/employee/tasks") return json([task]);
    if (path === "/employee/tasks/task/view") return json(task);
    if (path === "/employee/tasks/task/facts") return json({ ...task, factsConfirmed: true });
    if (path === "/employee/tasks/task/events") return json({ ...task, factsConfirmed: true });
    if (path === "/platform/settings")
      return json({
        groups: [
          {
            slug: "storage",
            settings: [
              {
                key: "storage.provider",
                value: settings.get("storage.provider") ?? "S3",
                source: settings.has("storage.provider") ? "DATABASE" : "DEFAULT",
                configured: true,
                secret: false,
              },
              ...["storage.endpoint", "storage.region", "storage.bucket"].map((key) => ({
                key,
                value: settings.get(key) ?? (key.endsWith("region") ? "us-east-1" : ""),
                configured: settings.has(key),
                secret: false,
              })),
              ...["storage.access_key_id", "storage.secret_access_key"].map((key) => ({
                key,
                value: null,
                configured: settings.has(key),
                secret: true,
              })),
              { key: "storage.force_path_style", value: true, configured: true, secret: false },
            ],
          },
        ],
      });
    if (path === "/platform/settings/storage/test") return json({ signedReadVerified: true });
    if (path.startsWith("/platform/settings/") && method === "POST") {
      settings.set(
        decodeURIComponent(path.slice("/platform/settings/".length)),
        body.value as string | boolean,
      );
      return json({});
    }
    if (path.endsWith("/generation-status"))
      return json({ notices: [], affectedEnterpriseCount: 0 });
    return json({});
  });
  proxy = createServer((request, response) => {
    const upstream = httpRequest(
      {
        hostname: "127.0.0.1",
        port: 23111,
        path: request.url,
        method: request.method,
        headers: {
          ...request.headers,
          host: "127.0.0.1:23111",
          "x-forwarded-host": request.headers.host,
          "x-forwarded-proto": "http",
        },
      },
      (received) => {
        response.writeHead(received.statusCode ?? 502, received.headers);
        received.pipe(response);
      },
    );
    upstream.on("error", () => {
      response.writeHead(502);
      response.end();
    });
    request.pipe(upstream);
  });
  await listen(api, 23110);
  await listen(proxy, 23112);
});

test.beforeEach(() => {
  initialized = false;
  refreshes = 0;
  settings.clear();
  requests.length = 0;
  writes.length = 0;
});
test.afterAll(async () => {
  await close(proxy);
  await close(api);
});

async function login(page: Page, origin: string) {
  await page.goto(`${origin}/login?returnTo=/employee`);
  await page.getByLabel("账号", { exact: true }).fill("owner");
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "我的内容任务" })).toBeVisible();
}

for (const width of [1440, 390]) {
  test(`HTTP IP installation, refresh, login and real copy ${width}`, async ({
    page,
    context,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`${ipOrigin}/login`);
    await expect(page).toHaveURL(`${ipOrigin}/setup`);
    expect(
      await page.evaluate(() => ({
        secure: window.isSecureContext,
        uuid: typeof crypto.randomUUID,
        clipboard: typeof navigator.clipboard,
      })),
    ).toEqual({ secure: false, uuid: "undefined", clipboard: "undefined" });
    await page.getByLabel("安装凭证", { exact: true }).fill("fixture-installation-proof");
    await page.getByLabel("管理员账号", { exact: true }).fill("owner");
    await page.getByLabel("管理员姓名", { exact: true }).fill("示例管理员");
    await page.getByLabel("管理员密码", { exact: true }).fill(password);
    await page.getByLabel("确认密码", { exact: true }).fill(password);
    await page.getByLabel("企业名称", { exact: true }).fill("示例企业");
    await page.getByRole("button", { name: "创建管理员并完成安装", exact: true }).click();
    await expect(page.getByRole("heading", { name: "安装完成", exact: true })).toBeVisible();
    const cookie = (await context.cookies()).find((item) => item.name === cookieName);
    expect(cookie).toMatchObject({
      httpOnly: true,
      secure: false,
      sameSite: "Strict",
      path: "/api/auth/admin",
    });
    await expect(page.getByLabel("存储方式", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("S3 API 地址", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "进入工作台", exact: true })).toHaveAttribute(
      "href",
      "/console",
    );
    expect(requests.filter((path) => path.startsWith("/platform/settings"))).toEqual([]);
    expect(settings.get("storage.provider")).toBe("LOCAL");
    expect(settings.has("storage.access_key_id")).toBe(false);
    await page.reload();
    await expect(page.getByRole("heading", { name: "安装完成", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "进入工作台", exact: true })).toBeVisible();
    expect(requests.filter((path) => path.startsWith("/platform/settings"))).toEqual([]);
    expect(refreshes).toBeGreaterThan(0);
    expect(writes.find((item) => item.path === "/auth/admin/refresh")?.cookie).toContain(
      `${cookieName}=fixture-refresh-cookie`,
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: testInfo.outputPath(`http-ip-setup-${width}.png`),
      fullPage: true,
    });
    await page.goto(`${ipOrigin}/employee`);
    await page.getByRole("button", { name: /真实图文任务/u }).click();
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "确认真实", exact: true }).click();
    await expect(page.getByRole("button", { name: "复制文案" })).toBeEnabled();
    await page.evaluate(() => {
      const original = document.execCommand.bind(document);
      document.execCommand = (...args: Parameters<Document["execCommand"]>) => {
        if (args[0] === "copy")
          (window as unknown as { copyText: string }).copyText = (
            document.activeElement as HTMLTextAreaElement
          ).value;
        return original(...args);
      };
    });
    await page.getByRole("button", { name: "复制文案" }).click();
    await expect(page.getByRole("status").filter({ hasText: "文案已复制" })).toBeVisible();
    expect(
      await page.evaluate(() => (window as unknown as { copyText: string }).copyText),
    ).toContain("这是我确认过的真实记录。");
    await page.getByRole("button", { name: "退出登录" }).click();
    await expect(page).toHaveURL(`${ipOrigin}/login`);
    expect((await context.cookies()).some((item) => item.name === cookieName)).toBe(false);
    await login(page, ipOrigin);
    await page.reload();
    await expect(page.getByRole("heading", { name: "我的内容任务" })).toBeVisible();
    expect(writes.filter((item) => item.path === "/auth/admin/refresh").length).toBeGreaterThan(1);
  });
}

test("different reverse-proxy domains work without a build or DNS setup", async ({
  page,
  context,
}, testInfo) => {
  initialized = true;
  for (const host of ["first-domain.example.test", "second-domain.example.test"]) {
    const origin = `http://${host}:23112`;
    await login(page, origin);
    const cookie = (await context.cookies()).find(
      (item) => item.name === cookieName && item.domain === host,
    );
    expect(cookie).toMatchObject({ secure: false, httpOnly: true, path: "/api/auth/admin" });
    await page.reload();
    await expect(page.getByRole("heading", { name: "我的内容任务" })).toBeVisible();
    expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
  }
  await page.screenshot({ path: testInfo.outputPath("reverse-proxy-domain.png"), fullPage: true });
  expect(refreshes).toBeGreaterThan(1);
});

test("the actual gateway rejects foreign-origin writes before the business API", async ({
  request,
}) => {
  const response = await request.post(`${ipOrigin}/api/auth/admin/installation`, {
    headers: { origin: "http://foreign.example.test" },
    data: { username: "attacker" },
  });
  expect(response.status()).toBe(403);
  expect(writes).toHaveLength(0);
  expect(initialized).toBe(false);
});
