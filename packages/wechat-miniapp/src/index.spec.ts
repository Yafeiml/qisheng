import { describe, expect, it, vi } from "vitest";
import {
  formatSubscriptionData,
  parseSubscriptionTemplateMapping,
  validateSubscriptionTemplateMapping,
  WechatMiniappClient,
  WechatMiniappError,
  type WechatSubscriptionInput,
} from "./index";

const credentials = { appId: "wx1111111111111111", appSecret: "a".repeat(32) };
const subscription: WechatSubscriptionInput = {
  ...credentials,
  openId: "openid_fixture",
  templateId: "template_fixture",
  page: "pages/task/detail?id=fixture_task",
  environment: "formal",
  data: { thing1: { value: "新任务" } },
};
const response = (body: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(body), init);
const token = (value = "token_fixture"): Response =>
  response({ access_token: value, expires_in: 7200 });

describe("WeChat miniapp client", () => {
  it("exchanges code only with the fixed HTTPS endpoint and projects identity without session_key", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        openid: "openid_fixture",
        unionid: "union_fixture",
        session_key: "must-not-escape",
      }),
    );
    const client = new WechatMiniappClient({ fetch: fetcher });
    const identity = await client.exchangeCode({ ...credentials, code: "login_code_fixture" });
    expect(identity).toEqual({ openId: "openid_fixture", unionId: "union_fixture" });
    const [request, init] = fetcher.mock.calls[0] ?? [];
    const url = new URL(String(request));
    expect(url.origin).toBe("https://api.weixin.qq.com");
    expect(url.pathname).toBe("/sns/jscode2session");
    expect(url.searchParams.get("grant_type")).toBe("authorization_code");
    expect(init).toMatchObject({ method: "GET", redirect: "error" });
  });

  it("shares one stable token across concurrent sends and includes exact template data", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input) =>
        new URL(String(input)).pathname === "/cgi-bin/stable_token"
          ? token()
          : response({ errcode: 0 }),
      );
    const client = new WechatMiniappClient({ fetch: fetcher });
    await Promise.all([
      client.sendSubscription(subscription),
      client.sendSubscription(subscription),
    ]);
    await client.sendSubscription(subscription);
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes("stable_token"))).toHaveLength(
      1,
    );
    expect(
      fetcher.mock.calls.filter(([url]) => String(url).includes("subscribe/send")),
    ).toHaveLength(3);
    const [url, init] =
      fetcher.mock.calls.find(([url]) => String(url).includes("subscribe/send")) ?? [];
    expect(new URL(String(url)).origin).toBe("https://api.weixin.qq.com");
    expect(JSON.parse(String(init?.body))).toEqual({
      touser: subscription.openId,
      template_id: subscription.templateId,
      page: subscription.page,
      miniprogram_state: "formal",
      lang: "zh_CN",
      data: subscription.data,
    });
    expect(init?.redirect).toBe("error");
  });

  it("separates cache entries when the app or credential changes", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input) =>
        String(input).includes("stable_token") ? token() : response({ errcode: 0 }),
      );
    const client = new WechatMiniappClient({ fetch: fetcher });
    await client.sendSubscription(subscription);
    await client.sendSubscription({ ...subscription, appSecret: "b".repeat(32) });
    await client.sendSubscription({ ...subscription, appId: "wx0123456789abcdef" });
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes("stable_token"))).toHaveLength(
      3,
    );
  });

  it.each([40001, 40014, 42001])(
    "refreshes a definitively rejected token once for %s",
    async (errcode) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(token("token_initial"))
        .mockResolvedValueOnce(response({ errcode }))
        .mockResolvedValueOnce(token("token_refreshed"))
        .mockResolvedValueOnce(response({ errcode: 0 }));
      const client = new WechatMiniappClient({ fetch: fetcher });
      await client.sendSubscription(subscription);
      expect(fetcher).toHaveBeenCalledTimes(4);
      expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toMatchObject({
        force_refresh: true,
      });
      expect(new URL(String(fetcher.mock.calls[3]?.[0])).searchParams.get("access_token")).toBe(
        "token_refreshed",
      );
    },
  );

  it("does not keep refreshing when a new token is also rejected", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(token("token_initial"))
      .mockResolvedValueOnce(response({ errcode: 40001 }))
      .mockResolvedValueOnce(token("token_refreshed"))
      .mockResolvedValueOnce(response({ errcode: 40001 }));
    await expect(
      new WechatMiniappClient({ fetch: fetcher }).sendSubscription(subscription),
    ).rejects.toMatchObject({ code: "40001", disposition: "PERMANENT" });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("refreshes a definitively rejected token even when the rejection uses HTTP 401", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(token("token_initial"))
      .mockResolvedValueOnce(response({ errcode: 42001 }, { status: 401 }))
      .mockResolvedValueOnce(token("token_refreshed"))
      .mockResolvedValueOnce(response({ errcode: 0 }));
    await new WechatMiniappClient({ fetch: fetcher }).sendSubscription(subscription);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it.each([
    [43101, "UNAUTHORIZED"],
    [40003, "PERMANENT"],
    [40037, "PERMANENT"],
    [47003, "PERMANENT"],
    [-1, "RETRYABLE"],
    [45009, "RETRYABLE"],
  ])("classifies provider rejection %s as %s without resending", async (errcode, disposition) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(response({ errcode, errmsg: "provider payload secret" }));
    const error = await new WechatMiniappClient({ fetch: fetcher })
      .sendSubscription(subscription)
      .catch((error) => error);
    expect(error).toBeInstanceOf(WechatMiniappError);
    expect(error).toMatchObject({ code: String(errcode), disposition });
    expect(String(error)).not.toContain("provider payload");
    expect(JSON.stringify(error)).not.toContain("provider payload");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("classifies unknown send transport outcomes as uncertain and never resends", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(token())
      .mockRejectedValueOnce(
        new Error(`connection lost at https://api.weixin.qq.com?secret=${credentials.appSecret}`),
      );
    const error = await new WechatMiniappClient({ fetch: fetcher })
      .sendSubscription(subscription)
      .catch((error) => error);
    expect(error).toMatchObject({ code: "TRANSPORT_FAILURE", disposition: "UNCERTAIN" });
    expect(String(error)).not.toContain(credentials.appSecret);
    expect(error.cause).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("aborts timed out sends without an automatic resend", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(token())
      .mockImplementationOnce(
        async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("secret timeout")), {
              once: true,
            });
          }),
      );
    await expect(
      new WechatMiniappClient({ fetch: fetcher, timeoutMs: 5 }).sendSubscription(subscription),
    ).rejects.toMatchObject({ code: "TIMEOUT", disposition: "UNCERTAIN" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    new Response("{broken"),
    response({ errcode: "0" }),
    response({ unexpected: true }),
    new Response("x".repeat(65_537)),
    new Response("x", { headers: { "content-length": "999999999" } }),
    response({}, { status: 503 }),
  ])(
    "treats malformed, oversized and ambiguous HTTP send responses as uncertain",
    async (sendResponse) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(token())
        .mockResolvedValueOnce(sendResponse);
      await expect(
        new WechatMiniappClient({ fetch: fetcher }).sendSubscription(subscription),
      ).rejects.toMatchObject({ disposition: "UNCERTAIN" });
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );

  it("does not attempt a send when token retrieval fails and does not expose credential errors", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ errcode: 40125, errmsg: credentials.appSecret }));
    const error = await new WechatMiniappClient({ fetch: fetcher })
      .sendSubscription(subscription)
      .catch((error) => error);
    expect(error).toMatchObject({ code: "40125", disposition: "PERMANENT" });
    expect(JSON.stringify(error)).not.toContain(credentials.appSecret);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    { appId: "https://evil.example" },
    { appSecret: "secret\nheader" },
    { openId: "../../injection" },
    { templateId: "template?secret=leak" },
    { page: "https://evil.example/path" },
    { page: "../pages/task" },
    { page: "/pages/task" },
    { environment: "invalid" },
    { data: { thing1: { value: "x".repeat(21) } } },
    { data: JSON.parse('{"__proto__":{"value":"pollution"}}') },
  ])("rejects invalid identifiers, pages and data before network access: %j", async (override) => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      new WechatMiniappClient({ fetch: fetcher }).sendSubscription({
        ...subscription,
        ...override,
      } as WechatSubscriptionInput),
    ).rejects.toMatchObject({ disposition: "PERMANENT" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("subscription template mapping", () => {
  it("formats the selected real new-task template with task platform and expiration time", () => {
    const mapping = parseSubscriptionTemplateMapping(
      '{"thing4":"TASK_TITLE","time5":"EXPIRES_AT","thing12":"TASK_TYPE","thing11":"REMARK","thing13":"TASK_PLATFORM"}',
    );
    const data = {
      title: "示例眼科新任务",
      enterpriseName: "示例测试眼科医院",
      visibleAt: new Date("2026-10-06T01:00:00.000Z"),
      expiresAt: new Date("2026-10-07T04:30:00.000Z"),
      remark: "新的发布任务已开放",
      taskType: "发布任务",
    };
    expect(formatSubscriptionData(mapping, data)).toEqual({
      thing4: { value: "示例眼科新任务" },
      time5: { value: "2026-10-07 12:30:00" },
      thing12: { value: "发布任务" },
      thing11: { value: "新的发布任务已开放" },
      thing13: { value: "小红书" },
    });
    expect(
      formatSubscriptionData(mapping, { ...data, taskPlatform: "微信视频号" }).thing13,
    ).toEqual({ value: "微信视频号" });
  });

  it("formats configured fields and China dates without depending on server timezone", () => {
    const mapping = parseSubscriptionTemplateMapping(
      '{"thing1":"TASK_TITLE","thing2":"ENTERPRISE_NAME","time3":"VISIBLE_AT","date4":"EXPIRES_AT","phrase5":"TASK_STATUS"}',
    );
    expect(
      formatSubscriptionData(mapping, {
        title: "领取任务",
        enterpriseName: "示例眼科",
        visibleAt: "2026-10-05T16:00:00.000Z",
        expiresAt: new Date("2026-10-06T16:00:00.000Z"),
      }),
    ).toEqual({
      thing1: { value: "领取任务" },
      thing2: { value: "示例眼科" },
      time3: { value: "2026-10-06 00:00:00" },
      date4: { value: "2026-10-07" },
      phrase5: { value: "待领取" },
    });
  });

  it("truncates thing and phrase by Unicode characters and normalizes controls", () => {
    const result = formatSubscriptionData(
      { thing1: "TASK_TITLE", phrase2: "ENTERPRISE_NAME", thing3: "REMARK" },
      {
        title: "😀".repeat(22),
        enterpriseName: "示例眼科医院集团",
        visibleAt: new Date(),
        expiresAt: new Date(),
        remark: " 新任务\n\t请领取 ",
      },
    );
    expect(result).toEqual({
      thing1: { value: "😀".repeat(20) },
      phrase2: { value: "示例眼科医" },
      thing3: { value: "新任务 请领取" },
    });
  });

  it.each([
    "not JSON",
    "null",
    "[]",
    "{}",
    '{"__proto__":"TASK_TITLE"}',
    '{"constructor":"TASK_TITLE"}',
    '{"time1":"TASK_TITLE"}',
    '{"thing1":"VISIBLE_AT"}',
    '{"thing1":"UNKNOWN_SOURCE"}',
    '{"time1":"VISIBLE_AT"}',
    '{"phrase0":"TASK_TITLE"}',
    '{"thing1":"TASK_TITLE","thing2":"TASK_TITLE","thing3":"TASK_TITLE","thing4":"TASK_TITLE","thing5":"TASK_TITLE","thing6":"TASK_TITLE"}',
  ])("rejects invalid mapping including incompatible field types: %s", (json) => {
    expect(() => parseSubscriptionTemplateMapping(json)).toThrow(WechatMiniappError);
  });

  it("rejects prototype-bearing maps and ambiguous or missing time values", () => {
    expect(() =>
      validateSubscriptionTemplateMapping(Object.create({ thing1: "TASK_TITLE" })),
    ).toThrow(WechatMiniappError);
    const mapping = { thing1: "TASK_TITLE", time2: "VISIBLE_AT" } as const;
    for (const visibleAt of ["2026-10-06 10:00:00", "invalid", new Date(Number.NaN)]) {
      expect(() =>
        formatSubscriptionData(mapping, {
          title: "task",
          enterpriseName: "enterprise",
          visibleAt,
          expiresAt: new Date(),
        }),
      ).toThrow(WechatMiniappError);
    }
  });
});
