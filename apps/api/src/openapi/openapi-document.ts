import type { INestApplication } from "@nestjs/common";
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from "@nestjs/swagger";

export const OPENAPI_JSON_PATH = "openapi.json";
export const OPENAPI_UI_PATH = "api-docs";

export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  const configuration = new DocumentBuilder()
    .setTitle("企声发布 SaaS API")
    .setDescription(
      "平台、集团、企业管理端与员工端的统一 API 契约。模型 Provider 与路由只属于平台控制面。",
    )
    .setVersion("0.1.0")
    .addBearerAuth(
      {
        bearerFormat: "JWT",
        description: "短期管理端或员工端 Access Token；不同 audience 不能互换。",
        scheme: "bearer",
        type: "http",
      },
      "access-token",
    )
    .addCookieAuth("xhs_admin_refresh", {
      description: "管理端轮换 Refresh Session，仅由浏览器作为 HttpOnly Cookie 发送。",
      in: "cookie",
      type: "apiKey",
    })
    .build();

  const document = SwaggerModule.createDocument(app, configuration, {
    operationIdFactory: (controllerKey, methodKey) => `${controllerKey}_${methodKey}`,
  });
  applyGlobalContract(document);
  return document;
}

export function mountOpenApi(app: INestApplication): void {
  SwaggerModule.setup(OPENAPI_UI_PATH, app, createOpenApiDocument(app), {
    customSiteTitle: "企声发布 API Contract",
    jsonDocumentUrl: OPENAPI_JSON_PATH,
    swaggerOptions: {
      displayOperationId: true,
      persistAuthorization: false,
    },
  });
}

function applyGlobalContract(document: OpenAPIObject): void {
  document.components ??= {};
  document.components.schemas ??= {};
  document.components.schemas.ApiError = {
    properties: {
      code: { example: "VALIDATION_FAILED", type: "string" },
      details: { nullable: true },
      message: { example: "Request validation failed", type: "string" },
      path: { example: "/auth/admin/login", type: "string" },
      requestId: { example: "a686bd46-66dd-492d-a9fc-47706735e62e", type: "string" },
      statusCode: { example: 400, type: "integer" },
      timestamp: { format: "date-time", type: "string" },
    },
    required: ["code", "message", "path", "requestId", "statusCode", "timestamp"],
    type: "object",
  };

  for (const [path, pathItem] of Object.entries(document.paths)) {
    for (const operation of Object.values(pathItem ?? {})) {
      if (!operation || typeof operation !== "object" || !("responses" in operation)) continue;
      operation.parameters ??= [];
      operation.parameters.push({
        description: "可选的调用方请求 ID；格式非法时服务端会重新生成。",
        in: "header",
        name: "X-Request-Id",
        required: false,
        schema: { maxLength: 100, minLength: 8, type: "string" },
      });
      operation.responses.default = {
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/ApiError" } },
        },
        description: "统一错误响应",
        headers: {
          "X-Request-Id": {
            description: "服务端接受或生成的请求 ID",
            schema: { type: "string" },
          },
        },
      };
      for (const response of Object.values(operation.responses)) {
        if (!response || typeof response !== "object") continue;
        const describedResponse = response as {
          headers?: Record<string, unknown>;
        };
        describedResponse.headers ??= {};
        describedResponse.headers["X-Request-Id"] ??= {
          description: "服务端接受或生成的请求 ID",
          schema: { type: "string" },
        };
      }
      if (path.startsWith("/platform/") || path.startsWith("/console/")) {
        operation.security = [{ "access-token": [] }];
      } else if (path.startsWith("/employee/")) {
        operation.security = [{ "access-token": [] }];
      } else if (["/auth/admin/logout", "/auth/admin/refresh"].includes(path)) {
        operation.security = [{ xhs_admin_refresh: [] }];
      }
    }
  }
}
