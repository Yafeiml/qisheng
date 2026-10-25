import { describe, expect, it, vi } from "vitest";
import { EnvironmentCredentialResolver } from "./credential-resolver";
import { createRuntimeProvider } from "./provider-factory";

describe("runtime provider credentials", () => {
  it("resolves only strict env references", async () => {
    const resolver = new EnvironmentCredentialResolver({ PILOT_PROVIDER_KEY: "runtime-secret" });
    await expect(resolver.resolve("env://PILOT_PROVIDER_KEY")).resolves.toBe("runtime-secret");
    await expect(resolver.resolve("vault://providers/a")).rejects.toThrow("not available");
    await expect(resolver.resolve("plain-text-secret")).rejects.toThrow("not available");
  });

  it("creates provider pairs without retaining the credential in public definitions", async () => {
    const resolver = new EnvironmentCredentialResolver({ PILOT_PROVIDER_KEY: "runtime-secret" });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "内容" } }] }),
          { status: 200 },
        ),
      );
    const provider = await createRuntimeProvider(
      {
        baseUrl: "https://provider.example/v1",
        credentialRef: "env://PILOT_PROVIDER_KEY",
        id: "provider-a",
        protocol: "OPENAI_COMPATIBLE",
        synthetic: false,
        timeoutMs: 30_000,
      },
      resolver,
      fetcher,
    );

    await expect(
      provider.text.generate("text-model", {
        context: { generationRunId: "run", tenantId: "tenant" },
        prompt: "prompt",
      }),
    ).resolves.toMatchObject({ text: "内容" });
    const request = fetcher.mock.calls[0]?.[1];
    expect(new Headers(request?.headers).get("authorization")).toBe("Bearer runtime-secret");
  });
});
