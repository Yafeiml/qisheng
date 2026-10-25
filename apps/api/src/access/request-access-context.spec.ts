import { describe, expect, it } from "vitest";
import { platformAccessScope } from "./access-scope";
import { RequestAccessContext } from "./request-access-context";

describe("RequestAccessContext", () => {
  it("rejects access before authentication initializes the request", () => {
    const context = new RequestAccessContext();

    expect(() => context.requirePrincipal()).toThrow("Request has no authenticated principal");
  });

  it("keeps employee credentials out of SaaS access", () => {
    const context = new RequestAccessContext();
    context.initialize({
      audience: "EMPLOYEE",
      membershipIds: ["membership-a"],
      userId: "user-a",
    });

    expect(() => context.requireSaasAdmin()).toThrow(
      "Employee credentials cannot access SaaS resources",
    );
    expect(context.requireEmployee().membershipIds).toEqual(["membership-a"]);
  });

  it("cannot be replaced after authentication has initialized it", () => {
    const context = new RequestAccessContext();
    context.initialize({
      audience: "SAAS_ADMIN",
      permissions: ["tenant.read"],
      scope: platformAccessScope(),
      userId: "admin-a",
    });

    expect(() =>
      context.initialize({
        audience: "EMPLOYEE",
        membershipIds: [],
        userId: "user-b",
      }),
    ).toThrow("Request access context has already been initialized");
  });
});
