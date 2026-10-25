import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { PrismaClient } from "@xhs-agentic/database";
import { setExistingAdministratorPassword } from "../../apps/api/src/identity/password-account-recovery.js";

async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.argv.length > 2)
    throw new Error("请在交互终端运行此命令；不接受命令行密码或重定向输入");
  if (!process.env.DATABASE_URL && existsSync(".env")) process.loadEnvFile(".env");
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) process.stdout.write(chunk);
      done();
    },
  });
  const terminal = createInterface({ input: process.stdin, output, terminal: true });
  const abort = new AbortController();
  terminal.on("SIGINT", () => abort.abort());
  const question = (prompt: string) => terminal.question(prompt, { signal: abort.signal });
  const prisma = new PrismaClient();
  try {
    process.stdout.write(
      "为已有管理员设置账号密码。成功后会注销该账号的全部会话；不会新增账号或授予权限。\n",
    );
    const phone = (await question("已有管理员手机号：")).trim();
    const username = (await question("登录账号（3–64 位字母、数字、点、下划线或短横线）：")).trim();
    process.stdout.write("新密码（12–128 位，含字母和数字，输入不回显）：");
    muted = true;
    const password = await question("");
    muted = false;
    process.stdout.write("\n再次输入密码：");
    muted = true;
    const confirmation = await question("");
    muted = false;
    process.stdout.write("\n");
    if (password !== confirmation) throw new Error("两次密码不一致，未作修改");
    const result = await setExistingAdministratorPassword(prisma, { phone, username, password });
    process.stdout.write(`已更新账号 ${result.username}，原权限已保留，全部旧会话已注销。\n`);
  } finally {
    terminal.close();
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error &&
    (error.name.endsWith("Exception") || ["AbortError", "Error"].includes(error.name))
      ? error.message
      : "设置失败，请检查数据库连接和迁移状态；原凭证事务未完成时会回滚";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
