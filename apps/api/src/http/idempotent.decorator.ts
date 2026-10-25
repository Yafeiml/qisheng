import { applyDecorators, SetMetadata } from "@nestjs/common";
import { ApiHeader } from "@nestjs/swagger";

export const IDEMPOTENT_OPERATION = Symbol("IDEMPOTENT_OPERATION");
export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

/** Marks a write operation as requiring a caller-generated idempotency key. */
export function Idempotent(): MethodDecorator {
  return applyDecorators(
    SetMetadata(IDEMPOTENT_OPERATION, true),
    ApiHeader({
      description:
        "调用方为一次业务操作生成的唯一键。相同用户、相同请求和相同键会重放首次成功响应。",
      name: "Idempotency-Key",
      required: true,
      schema: {
        maxLength: 200,
        minLength: 8,
        pattern: "^[A-Za-z0-9._:-]+$",
        type: "string",
      },
    }),
  );
}
