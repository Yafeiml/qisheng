import { Module } from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { AccessModule } from "../access/access.module";
import { IdempotencyInterceptor } from "./idempotency.interceptor";
import { IdempotencyService } from "./idempotency.service";
import { RateLimitGuard } from "./rate-limit.guard";
import { RequestLoggingInterceptor } from "./request-logging.interceptor";

@Module({
  imports: [AccessModule],
  providers: [
    IdempotencyService,
    {
      provide: APP_GUARD,
      useClass: RateLimitGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: RequestLoggingInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: IdempotencyInterceptor,
    },
  ],
})
export class HttpInfrastructureModule {}
