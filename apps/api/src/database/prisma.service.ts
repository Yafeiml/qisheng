import { Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@xhs-agentic/database";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnApplicationShutdown {
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.$disconnect();
  }
}
