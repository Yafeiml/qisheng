import "reflect-metadata";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ExecutionContext } from "@nestjs/common";
import { PrismaClient } from "@xhs-agentic/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminTokenAuthenticator } from "../access/admin-token-authenticator";
import { AuthTokenService } from "../access/auth-token.service";
import { seedAuthorizationCatalog } from "../access/authorization.seed";
import { EmployeeAccessGuard } from "../access/employee-access.guard";
import { RequestAccessContext } from "../access/request-access-context";
import type { PrismaService } from "../database/prisma.service";
import type { PlatformSettingsReader } from "../platform-settings/platform-settings.reader";
import { AdminAuthenticationService } from "./admin-auth.service";
import { AdminSessionService } from "./admin-session.service";
import type { AdminSmsService } from "./admin-sms.service";
import { EmployeeWebService } from "./employee-web.service";
import { hashPassword } from "./password";
import { setExistingAdministratorPassword } from "./password-account-recovery";
import { SmsSecurityService } from "./sms-security.service";

describe("self-hosted installation and managed password accounts", { concurrent: false }, () => {
  const schema = `password_auth_${randomUUID().replaceAll("-", "")}`;
  const tables = [
    "permissions",
    "roles",
    "role_permissions",
    "role_bindings",
    "admin_users",
    "tenants",
    "enterprises",
    "tenant_capability_policies",
    "runtime_policies",
    "platform_settings",
    "audit_logs",
    "admin_sessions",
    "global_users",
    "enterprise_memberships",
  ];
  let root: PrismaClient;
  let db: PrismaClient;
  let auth: AdminAuthenticationService;
  let authenticator: AdminTokenAuthenticator;
  let security: SmsSecurityService;
  const tokens = new AuthTokenService();
  const password = "Test-password-2026";

  beforeAll(async () => {
    vi.stubEnv("MODEL_CREDENTIAL_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
    vi.stubEnv("MODEL_CREDENTIAL_ENCRYPTION_KEY_VERSION", "installation-integration-v1");
    const url = new URL(process.env.DATABASE_URL ?? "");
    if (
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      !url.pathname.startsWith("/dev_")
    )
      throw new Error("Password integration tests require a local dev_ database");
    root = new PrismaClient();
    await root.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    const enumTypes = await root.$queryRaw<
      { typname: string; labels: string[] }[]
    >`SELECT typname, array_agg(enumlabel::text ORDER BY enumsortorder) AS labels FROM pg_type JOIN pg_namespace n ON n.oid = typnamespace JOIN pg_enum ON enumtypid = pg_type.oid WHERE n.nspname = 'public' GROUP BY typname`;
    for (const { typname, labels } of enumTypes)
      await root.$executeRawUnsafe(
        `CREATE TYPE "${schema}"."${typname}" AS ENUM (${labels.map((label) => `'${label.replaceAll("'", "''")}'`).join(", ")})`,
      );
    for (const table of tables)
      await root.$executeRawUnsafe(
        `CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING DEFAULTS INCLUDING INDEXES)`,
      );
    const columns = await root.$queryRaw<
      { table_name: string; column_name: string; udt_name: string; column_default: string | null }[]
    >`SELECT table_name, column_name, udt_name, column_default FROM information_schema.columns WHERE table_schema = ${schema} AND udt_schema = 'public' AND data_type = 'USER-DEFINED'`;
    for (const column of columns) {
      const table = `"${schema}"."${column.table_name}"`;
      const field = `"${column.column_name}"`;
      const type = `"${schema}"."${column.udt_name}"`;
      await root.$executeRawUnsafe(`ALTER TABLE ${table} ALTER COLUMN ${field} DROP DEFAULT`);
      await root.$executeRawUnsafe(
        `ALTER TABLE ${table} ALTER COLUMN ${field} TYPE ${type} USING ${field}::text::${type}`,
      );
      if (column.column_default)
        await root.$executeRawUnsafe(
          `ALTER TABLE ${table} ALTER COLUMN ${field} SET DEFAULT ${column.column_default.replace(/::.+$/u, "")}::${type}`,
        );
    }
    url.searchParams.set("schema", schema);
    db = new PrismaClient({ datasourceUrl: url.toString() });
    const settings = {
      boolean: vi.fn(async () => false),
      number: vi.fn(async (key: string) =>
        key === "security.max_active_admin_sessions" ? 10 : 3600,
      ),
    } as unknown as PlatformSettingsReader;
    security = new SmsSecurityService(settings);
    authenticator = new AdminTokenAuthenticator(tokens, db as PrismaService);
    auth = new AdminAuthenticationService(
      db as PrismaService,
      tokens,
      authenticator,
      settings,
      {} as AdminSmsService,
      security,
    );
  });

  beforeEach(async () => {
    vi.stubEnv("INSTALLATION_TOKEN", randomBytes(32).toString("base64"));
    await db.$executeRawUnsafe(
      `TRUNCATE ${tables.map((table) => `"${schema}"."${table}"`).join(", ")}`,
    );
    await seedAuthorizationCatalog(db);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await auth?.onApplicationShutdown();
    await security?.onApplicationShutdown();
    await db?.$disconnect();
    if (root) {
      await root.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await root.$disconnect();
    }
  });

  const initialize = (username: string) =>
    auth.initializeInstallation({
      username,
      password,
      name: username,
      organizationName: `${username} workspace`,
      organizationType: "SINGLE_ENTERPRISE",
      installationToken: process.env.INSTALLATION_TOKEN ?? "",
    });

  async function existingAccount(username: string) {
    const user = await db.adminUser.create({
      data: { username, name: username, passwordHash: await hashPassword(password) },
    });
    const ownerScope = await db.roleBinding.findFirstOrThrow({
      where: { scopeType: "ENTERPRISE" },
    });
    await db.roleBinding.create({
      data: {
        userId: user.id,
        roleId: ownerScope.roleId,
        scopeType: "ENTERPRISE",
        scopeId: ownerScope.scopeId,
        tenantId: ownerScope.tenantId,
        enterpriseId: ownerScope.enterpriseId,
      },
    });
    return auth.passwordLogin({ username, password }, "192.0.2.77");
  }

  async function historicalInvitation(membershipId: string) {
    const token = randomBytes(32).toString("base64url");
    await db.enterpriseMembership.update({
      where: { id: membershipId },
      data: {
        webInvitationHash: createHash("sha256").update(token).digest("hex"),
        webInvitationExpiresAt: new Date(Date.now() + 3600_000),
      },
    });
    return { token };
  }

  it("atomically initializes only one organization and administrator", async () => {
    await db.rolePermission.deleteMany();
    await db.role.deleteMany();
    await db.permission.deleteMany();
    const results = await Promise.allSettled([initialize("alice"), initialize("bob")]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(await db.roleBinding.count({ where: { scopeType: "PLATFORM" } })).toBe(1);
    expect(await db.roleBinding.count({ where: { scopeType: "ENTERPRISE" } })).toBe(1);
    expect(await db.tenant.count()).toBe(1);
    expect(await db.adminUser.count({ where: { phone: null } })).toBe(1);
    const seeded = await db.$queryRawUnsafe<{ runtime: bigint; settings: bigint }[]>(
      `SELECT (SELECT count(*) FROM "${schema}"."runtime_policies") AS runtime, (SELECT count(*) FROM "${schema}"."platform_settings") AS settings`,
    );
    expect(seeded[0]?.runtime).toBe(1n);
    expect(seeded[0]?.settings).toBeGreaterThan(0n);
    expect(
      await db.platformSetting.findUnique({ where: { key: "storage.provider" } }),
    ).toMatchObject({
      value: "LOCAL",
      valueType: "ENUM",
      group: "STORAGE",
    });
    await expect(initialize("another-owner")).rejects.toMatchObject({ status: 409 });
  });

  it("preserves an existing S3 choice and encrypted credentials during first initialization", async () => {
    const ciphertext = randomBytes(32);
    await db.platformSetting.createMany({
      data: [
        {
          key: "storage.provider",
          group: "STORAGE",
          valueType: "ENUM",
          value: "S3",
          updatedBy: "existing-admin",
        },
        {
          key: "storage.secret_access_key",
          group: "STORAGE",
          valueType: "SECRET",
          ciphertext,
          keyVersion: "existing-key",
          updatedBy: "existing-admin",
        },
      ],
    });
    await initialize("owner");
    expect(
      await db.platformSetting.findUnique({ where: { key: "storage.provider" } }),
    ).toMatchObject({
      value: "S3",
      updatedBy: "existing-admin",
    });
    const secret = await db.platformSetting.findUniqueOrThrow({
      where: { key: "storage.secret_access_key" },
    });
    expect(Buffer.from(secret.ciphertext ?? [])).toEqual(ciphertext);
    expect(secret.keyVersion).toBe("existing-key");
  });

  it("rolls the local default and organization back if the installation receipt fails", async () => {
    await db.$executeRawUnsafe(
      `ALTER TABLE "${schema}"."audit_logs" ADD CONSTRAINT reject_installation_receipt CHECK (action <> 'installation.initialized')`,
    );
    try {
      await expect(initialize("owner")).rejects.toThrow();
      expect(await db.adminUser.count()).toBe(0);
      expect(await db.tenant.count()).toBe(0);
      expect(await db.enterprise.count()).toBe(0);
      expect(await db.adminSession.count()).toBe(0);
      expect(await db.platformSetting.count()).toBe(0);
    } finally {
      await db.$executeRawUnsafe(
        `ALTER TABLE "${schema}"."audit_logs" DROP CONSTRAINT reject_installation_receipt`,
      );
    }
  });

  it("never reinitializes over an existing SMS administrator", async () => {
    const user = await db.adminUser.create({ data: { phone: "13900009991" } });
    const role = await db.role.findUniqueOrThrow({ where: { code: "PLATFORM_ADMIN" } });
    await db.roleBinding.create({
      data: { userId: user.id, roleId: role.id, scopeType: "PLATFORM", scopeId: "platform" },
    });
    await expect(initialize("new-owner")).rejects.toMatchObject({ status: 409 });
    const bindings = await db.roleBinding.findMany({ where: { scopeType: "PLATFORM" } });
    expect(bindings.map(({ userId }) => userId)).toEqual([user.id]);
  });

  it("migrates an existing SMS administrator without granting roles, logs safely and revokes old sessions", async () => {
    const user = await db.adminUser.create({ data: { phone: "13900009995" } });
    const role = await db.role.findUniqueOrThrow({ where: { code: "PLATFORM_ADMIN" } });
    await db.roleBinding.create({
      data: { userId: user.id, roleId: role.id, scopeType: "PLATFORM", scopeId: "platform" },
    });
    const oldSession = await db.adminSession.create({
      data: {
        userId: user.id,
        refreshTokenHash: "old",
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    await setExistingAdministratorPassword(db, {
      phone: "13900009995",
      username: "migrated",
      password,
    });
    const login = await auth.passwordLogin({ username: "migrated", password }, "192.0.2.77");
    expect(tokens.verifyAdminAccessToken(login.accessToken).userId).toBe(user.id);
    expect(await db.roleBinding.count({ where: { userId: user.id } })).toBe(1);
    expect(
      (await db.adminSession.findUniqueOrThrow({ where: { id: oldSession.id } })).revokedAt,
    ).not.toBeNull();
    expect(JSON.stringify(await db.auditLog.findMany())).not.toContain(password);
    await expect(
      setExistingAdministratorPassword(db, { phone: "13900009996", username: "missing", password }),
    ).rejects.toMatchObject({ status: 404 });
    expect(await db.adminUser.count()).toBe(1);
  });

  it("verifies real passwords, refreshes and revokes sessions without SMS or email dependencies", async () => {
    const account = await initialize("owner");
    await expect(
      auth.passwordLogin({ username: "owner", password: "Wrong-password-2026" }, "192.0.2.77"),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      auth.passwordLogin({ username: "missing", password }, "192.0.2.77"),
    ).rejects.toMatchObject({ status: 401 });
    const login = await auth.passwordLogin({ username: "OWNER", password }, "192.0.2.77");
    const refreshed = await auth.refresh(login.refreshToken);
    expect(refreshed.sessionId).toBe(login.sessionId);
    await expect(auth.refresh(login.refreshToken)).rejects.toMatchObject({ status: 401 });
    await expect(
      authenticator.authenticate(`Bearer ${refreshed.accessToken}`),
    ).rejects.toMatchObject({ status: 401 });
    await auth.logoutAll(`Bearer ${account.accessToken}`);
    await expect(authenticator.authenticate(`Bearer ${account.accessToken}`)).rejects.toMatchObject(
      { status: 401 },
    );
    await db.adminUser.update({ where: { username: "owner" }, data: { status: "DISABLED" } });
    await expect(
      auth.passwordLogin({ username: "owner", password }, "192.0.2.77"),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("lets an administrator create an employee account without admin roles or a new workspace", async () => {
    const owner = await initialize("owner");
    const ownerId = tokens.verifyAdminAccessToken(owner.accessToken).userId;
    const enterprise = await db.enterprise.findFirstOrThrow();
    const membership = await db.enterpriseMembership.create({
      data: {
        tenantId: enterprise.tenantId,
        enterpriseId: enterprise.id,
        name: "员工",
        phone: "13900009992",
        seatStatus: "ENABLED",
      },
    });
    const context = new RequestAccessContext();
    context.initialize({
      audience: "SAAS_ADMIN",
      userId: ownerId,
      permissions: ["enterprise.membership.manage"],
      scope: { type: "ENTERPRISE", tenantId: enterprise.tenantId, enterpriseId: enterprise.id },
    });
    const web = new EmployeeWebService(db as PrismaService, authenticator, tokens, context);
    await web.createAccount(membership.id, { username: "employee", password });
    const employee = await auth.passwordLogin({ username: "employee", password }, "192.0.2.77");
    expect(await db.tenant.count()).toBe(1);
    const account = await db.adminUser.findUniqueOrThrow({ where: { username: "employee" } });
    if (!account.employeeUserId) throw new Error("Expected a linked employee identity");
    expect(await db.roleBinding.count({ where: { userId: account.id } })).toBe(0);
    expect(
      (await db.globalUser.findUniqueOrThrow({ where: { id: account.employeeUserId } })).phone,
    ).toBeNull();
    const employeeSession = await web.session(`Bearer ${employee.accessToken}`);
    expect(employeeSession.memberships.map(({ membershipId }) => membershipId)).toEqual([
      membership.id,
    ]);
    expect(tokens.verifyEmployeeAccessToken(employeeSession.accessToken)).toMatchObject({
      sessionId: employee.sessionId,
      userId: account.employeeUserId,
    });
    const guardContext = new RequestAccessContext();
    const guard = new EmployeeAccessGuard(tokens, db as PrismaService, guardContext);
    const execution = {
      switchToHttp: () => ({
        getRequest: () => ({ headers: { authorization: `Bearer ${employeeSession.accessToken}` } }),
      }),
    } as unknown as ExecutionContext;
    await expect(guard.canActivate(execution)).resolves.toBe(true);
    expect(guardContext.requireEmployee().membershipIds).toEqual([membership.id]);
    await auth.logout(employee.refreshToken);
    await expect(
      new EmployeeAccessGuard(tokens, db as PrismaService, new RequestAccessContext()).canActivate(
        execution,
      ),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      web.createAccount(membership.id, { username: "second-employee", password }),
    ).rejects.toMatchObject({ status: 409 });
    const login = await auth.passwordLogin({ username: "employee", password }, "192.0.2.77");
    const profile = await new AdminSessionService(authenticator, db as PrismaService).getSession(
      `Bearer ${login.accessToken}`,
    );
    expect(profile.scopes).toEqual([]);
    await auth.logout(login.refreshToken);
    await expect(web.session(`Bearer ${login.accessToken}`)).rejects.toMatchObject({ status: 401 });
  });

  it("binds an existing account to the explicit invitation without merging any phone identity", async () => {
    const owner = await initialize("owner");
    const employeeAccount = await existingAccount("existing");
    const enterprise = await db.enterprise.findFirstOrThrow({ where: { name: "owner workspace" } });
    const oldIdentity = await db.globalUser.create({ data: { phone: "13900009993" } });
    const membership = await db.enterpriseMembership.create({
      data: {
        tenantId: enterprise.tenantId,
        enterpriseId: enterprise.id,
        name: "员工",
        phone: "13900009993",
        seatStatus: "ENABLED",
      },
    });
    const context = new RequestAccessContext();
    context.initialize({
      audience: "SAAS_ADMIN",
      userId: tokens.verifyAdminAccessToken(owner.accessToken).userId,
      permissions: ["enterprise.membership.manage"],
      scope: { type: "ENTERPRISE", tenantId: enterprise.tenantId, enterpriseId: enterprise.id },
    });
    const web = new EmployeeWebService(db as PrismaService, authenticator, tokens, context);
    const invitation = await historicalInvitation(membership.id);
    const bound = await web.bind(`Bearer ${employeeAccount.accessToken}`, invitation.token);
    expect(bound.userId).not.toBe(oldIdentity.id);
    await expect(web.bind(`Bearer ${owner.accessToken}`, invitation.token)).rejects.toMatchObject({
      status: 409,
    });
    await db.enterpriseMembership.update({
      where: { id: membership.id },
      data: { status: "DISABLED" },
    });
    await expect(web.session(`Bearer ${employeeAccount.accessToken}`)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("allows only one account to consume a shared employee invitation concurrently", async () => {
    const owner = await initialize("owner");
    const [alice, bob] = await Promise.all([existingAccount("alice"), existingAccount("bob")]);
    const enterprise = await db.enterprise.findFirstOrThrow({ where: { name: "owner workspace" } });
    const membership = await db.enterpriseMembership.create({
      data: {
        tenantId: enterprise.tenantId,
        enterpriseId: enterprise.id,
        name: "员工",
        phone: "13900009994",
        seatStatus: "ENABLED",
      },
    });
    const context = new RequestAccessContext();
    context.initialize({
      audience: "SAAS_ADMIN",
      userId: tokens.verifyAdminAccessToken(owner.accessToken).userId,
      permissions: ["enterprise.membership.manage"],
      scope: { type: "ENTERPRISE", tenantId: enterprise.tenantId, enterpriseId: enterprise.id },
    });
    const web = new EmployeeWebService(db as PrismaService, authenticator, tokens, context);
    const invitation = await historicalInvitation(membership.id);
    const results = await Promise.allSettled([
      web.bind(`Bearer ${alice.accessToken}`, invitation.token),
      web.bind(`Bearer ${bob.accessToken}`, invitation.token),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(await db.adminUser.count({ where: { employeeUserId: { not: null } } })).toBe(1);
    expect(await db.globalUser.count()).toBe(1);
  });
});
