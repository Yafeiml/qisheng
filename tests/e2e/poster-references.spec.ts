import { expect, test } from "@playwright/test";
import { defaultGenerationStyles } from "../../packages/ai-gateway/src/generation-style";

const thumbnail = "data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA";

for (const width of [1440, 390]) {
  for (const ambiguous of [false, true]) {
    test(`poster reference suggestions and automatic logo survive draft restore at ${width}px; ambiguous = ${ambiguous}`, async ({
      page,
    }) => {
      const firstFile = ambiguous ? "李明-白衣.png" : "林示例-白衣.png";
      const secondFile = ambiguous ? "李强-手术衣.png" : "林示例-手术衣.png";
      await page.setViewportSize({ width, height: 950 });
      await page.addInitScript(() =>
        localStorage.setItem(
          "xhs-agentic:mvp-session:v1",
          JSON.stringify({ mode: "FORMAL", tenantId: "tenant", enterpriseId: "enterprise" }),
        ),
      );
      await page.route(/:3100\//u, (route) =>
        route.fulfill({ status: 404, json: { message: "Unmocked poster fixture" } }),
      );
      await page.route("**/campaign-planning/medical-options", (route) =>
        route.fulfill({ json: { enabled: false } }),
      );
      await page.route("**/auth/admin/refresh", (route) =>
        route.fulfill({ json: { accessToken: "fixture-token", expiresInSeconds: 3600 } }),
      );
      await page.route("**/auth/admin/account", (route) =>
        route.fulfill({
          json: {
            name: "图片验收管理员",
            email: "poster@example.test",
            emailVerifiedAt: "2026-10-09T00:00:00.000Z",
          },
        }),
      );
      await page.route("**/auth/admin/session", (route) =>
        route.fulfill({
          json: {
            userId: "admin",
            phone: "13800000000",
            features: {},
            scopes: [
              {
                scopeType: "ENTERPRISE",
                role: { name: "企业管理员", code: "ENTERPRISE_ADMIN" },
                tenant: { id: "tenant", name: "测试集团" },
                enterprise: { id: "enterprise", name: "测试企业", tenantId: "tenant" },
                permissions: [
                  "campaign.read",
                  "campaign.manage",
                  "material.read",
                  "material.manage",
                ],
              },
            ],
          },
        }),
      );
      let payload: Record<string, unknown> = {
        step: 1,
        title: ambiguous ? "推广李主任全飞手术" : "推广林院长全飞秒技术",
        prompt: ambiguous ? "推广李主任的全飞手术" : "对林院长进行全飞秒技术的推广",
        logoArtifactId: "legacy-logo-choice",
        focusEntityIds: ["product"],
        contentDirectionPresetId: "direction-education",
        imageStylePresetId: "image-minimal",
        visibleAt: new Date(Date.now() + 10 * 3600000).toISOString(),
      };
      let submitted: Record<string, unknown> | null = null;
      const images = [
        firstFile,
        secondFile,
        "全飞秒设备.png",
        "术前评估.png",
        "诊室.png",
        "第六张.png",
        "第七张.png",
        "周示例.png",
        "企业Logo.png",
        "白色Logo.png",
      ].map((fileName, index) => ({
        artifactId: `image-${index}`,
        materialId: "material",
        enterpriseId: "enterprise",
        title: fileName,
        fileName,
        description:
          index >= 8
            ? "企业原始标识"
            : ambiguous
              ? "相关授权图片，请确认是否为本次宣传对象"
              : "与林院长全飞秒主题相关的授权图片",
        usage: index >= 8 ? "LOGO" : "REFERENCE",
        score: index >= 7 ? 0 : 10 - index,
      }));
      await page.route("**/console/tenants/tenant/enterprises/enterprise/**", (route) => {
        const path = new URL(route.request().url()).pathname;
        let json: unknown = [];
        if (path.endsWith("/workspace"))
          json = {
            steps: [],

            capabilities: { imagesPerDistribution: 1 },
            counts: { effectiveMaterials: 2 },
          };
        else if (path.endsWith("/memberships"))
          json = {
            items: [
              {
                id: "employee",
                name: "测试员工",
                status: "ACTIVE",
                seatStatus: "ENABLED",
                participation: { status: "PARTICIPATING" },
              },
            ],
            pageInfo: { hasNextPage: false, nextCursor: null },
          };
        else if (path.endsWith("/generation-status"))
          json = { notices: [], affectedEnterpriseCount: 0 };
        else if (path.endsWith("/generation-styles"))
          json = { ...defaultGenerationStyles(), version: 1 };
        else if (path.endsWith("/draft")) {
          if (route.request().method() === "POST") payload = route.request().postDataJSON();
          json = { draft: { payload, step: payload.step, updatedAt: new Date().toISOString() } };
        } else if (path.endsWith("/preflight")) json = { ready: true, checks: [] };
        else if (path.endsWith("/retrieval-preview"))
          json = {
            focusOptions: [
              {
                id: "person",
                name: "林示例",
                enterpriseId: "enterprise",
                aliases: ["林院长"],
                type: "DOCTOR",
              },
              { id: "product", name: "ICLV5", enterpriseId: null, aliases: [], type: "DEVICE" },
            ],
            focusEntityIds: route.request().postDataJSON().focusEntityIds ?? ["person"],
            imageSelectionRequired: ambiguous,
            images,
            hits: [
              {
                chunkId: "text",
                materialTitle: "林示例眼科人物形象照",
                materialType: "IMAGE_REFERENCE",
                materialVersion: 1,
                rank: 1,
                score: 0.9,
                snippet: "用户提供的人物简介",
                enterpriseId: "enterprise",
              },
              {
                chunkId: "intro",
                materialTitle: "全飞秒技术资料",
                materialType: "TEXT",
                materialVersion: 2,
                rank: 2,
                score: 0.8,
                snippet: "技术介绍",
                enterpriseId: null,
              },
            ]
              .filter((hit) => !ambiguous || hit.materialType !== "IMAGE_REFERENCE")
              .map((hit, index) => ({ ...hit, rank: index + 1 })),
          };
        else if (path.endsWith("/preview"))
          json = { optimizedDataUrl: thumbnail, url: "https://original.invalid/photo.png" };
        else if (path.endsWith("/campaigns") && route.request().method() === "POST") {
          submitted = route.request().postDataJSON();
          return route.fulfill({
            status: 409,
            json: { message: "测试已捕获提交，未创建付费活动" },
          });
        }
        return route.fulfill({ json });
      });
      await page.goto("/console/campaigns/new");
      await expect(page.getByRole("region", { name: "本次宣传重点" })).toHaveCount(0);
      await expect(page.getByRole("combobox", { name: "内容方向", exact: true })).toHaveValue(
        "direction-education",
      );
      await expect(page.getByRole("combobox", { name: "图片风格", exact: true })).toHaveValue(
        "image-minimal",
      );
      await expect.poll(() => payload.focusEntityIds).toEqual(["product"]);
      await expect.poll(() => payload.contentDirectionPresetId).toBe("direction-education");
      await expect.poll(() => payload.imageStylePresetId).toBe("image-minimal");
      await expect.poll(() => payload.promptTemplateId).toBeUndefined();
      await page.screenshot({ path: `.artifacts/campaign-topic-${width}.png`, fullPage: true });
      await page.getByRole("button", { name: "下一步", exact: true }).click();
      await page.getByRole("button", { name: "下一步", exact: true }).click();
      const region = page.getByRole("region", { name: "额外参考图片（可选）" });
      await expect(region).toContainText(ambiguous ? "参考图片不会自动引用" : "无需操作也可继续");
      if (ambiguous) await expect(region.getByRole("checkbox", { checked: true })).toHaveCount(0);
      await expect(region.locator(".campaignReferenceGrid > article")).toHaveCount(5);
      await expect(page.getByRole("checkbox", { name: "第六张.png", exact: true })).toHaveCount(0);
      await expect(page.getByRole("checkbox", { name: "周示例.png", exact: true })).toHaveCount(0);
      await expect(page.getByRole("radio", { name: "企业Logo.png", exact: true })).toHaveCount(0);
      await expect(page.getByRole("checkbox", { name: "本次不添加 Logo" })).toHaveCount(0);
      if (!ambiguous)
        await expect(page.locator(".retrievalEvidenceList")).toContainText(
          "1. 林示例眼科人物形象照 · v1 · 图片",
        );
      else await expect(page.locator(".retrievalEvidenceList")).not.toContainText("人物形象照");
      await expect(page.locator(".retrievalEvidenceList")).toContainText(
        `${ambiguous ? 1 : 2}. 全飞秒技术资料 · v2 · 文字`,
      );
      const first = page.getByRole("checkbox", { name: firstFile, exact: true });
      if (ambiguous) {
        await expect(first).not.toBeChecked();
        await first.check();
      } else await expect(first).toBeChecked();
      await page.getByRole("checkbox", { name: secondFile, exact: true }).check();
      await page.getByRole("checkbox", { name: "全飞秒设备.png", exact: true }).check();
      const fourth = page.getByRole("checkbox", { name: "术前评估.png", exact: true });
      await expect(fourth).toBeDisabled();
      await expect(first).toHaveCSS("appearance", "none");
      await expect(first).toHaveCSS("width", "18px");
      await page.keyboard.press("Tab");
      await first.focus();
      await expect(first).toHaveCSS("outline-style", "solid");
      await first.uncheck();
      await expect(fourth).toBeEnabled();
      const reset = page.getByRole("button", {
        name: ambiguous ? "清除图片选择" : "恢复推荐选择",
        exact: true,
      });
      await reset.click();
      if (ambiguous) {
        await expect(first).not.toBeChecked();
        await first.check();
      } else await expect(first).toBeChecked();
      await expect(page.getByRole("checkbox", { name: secondFile, exact: true })).not.toBeChecked();
      await page.getByRole("checkbox", { name: secondFile, exact: true }).check();
      await page.getByRole("checkbox", { name: "全飞秒设备.png", exact: true }).check();
      await expect
        .poll(() => payload.referenceArtifactIds)
        .toEqual(["image-0", "image-1", "image-2"]);
      await expect.poll(() => payload.logoArtifactId).toBe("legacy-logo-choice");
      payload.referenceArtifactIds = ["image-0", "image-1", "image-2", "image-7"];
      await page.reload();
      await expect(page.getByRole("checkbox", { name: secondFile, exact: true })).toBeChecked();
      await expect
        .poll(() => payload.referenceArtifactIds)
        .toEqual(["image-0", "image-1", "image-2"]);
      await page.getByRole("button", { name: `预览${firstFile}`, exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(1);
      await page.screenshot({
        path: `.artifacts/poster-reference-preview-${width}-${ambiguous}.png`,
      });
      await page.getByRole("button", { name: `关闭${firstFile}` }).click();
      const cards = await region
        .locator(".campaignReferenceGrid > article")
        .evaluateAll((elements) =>
          elements.map((element) => ({
            x: element.getBoundingClientRect().x,
            y: element.getBoundingClientRect().y,
          })),
        );
      if (width === 1440) expect(new Set(cards.map((card) => card.y)).size).toBe(1);
      else expect(new Set(cards.map((card) => card.x)).size).toBe(2);
      const buttonWidth = await reset.evaluate((element) => element.getBoundingClientRect().width);
      expect(buttonWidth).toBeLessThan(140);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
      await page.screenshot({
        path: `.artifacts/poster-references-${width}-${ambiguous}.png`,
        fullPage: true,
      });
      await first.uncheck();
      await page.getByRole("checkbox", { name: secondFile, exact: true }).uncheck();
      await page.getByRole("checkbox", { name: "全飞秒设备.png", exact: true }).uncheck();
      await expect.poll(() => payload.referenceArtifactIds).toEqual([]);
      await page.getByRole("button", { name: "下一步", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "生成 1 份独立图文", exact: true }),
      ).toBeEnabled();
      await page.getByRole("button", { name: "上一步", exact: true }).click();
      await reset.click();
      if (ambiguous) await first.check();
      await page.getByRole("checkbox", { name: secondFile, exact: true }).check();
      await page.getByRole("checkbox", { name: "全飞秒设备.png", exact: true }).check();
      await page.getByRole("button", { name: "下一步", exact: true }).click();
      await page.getByRole("button", { name: "生成 1 份独立图文", exact: true }).click();
      await expect
        .poll(() => submitted)
        .toMatchObject({
          referenceArtifactIds: ["image-0", "image-1", "image-2"],
        });
      for (const field of ["focusEntityIds", "promptTemplateId", "logoArtifactId"])
        expect(submitted).not.toHaveProperty(field);
      expect(submitted).toMatchObject({
        contentDirectionPresetId: "direction-education",
        imageStylePresetId: "image-minimal",
      });
      if (ambiguous) {
        await page.getByRole("button", { name: "上一步", exact: true }).click();
        await reset.click();
        await expect(region.getByRole("checkbox", { checked: true })).toHaveCount(0);
        await page.getByRole("button", { name: "下一步", exact: true }).click();
        await page.getByRole("button", { name: "生成 1 份独立图文", exact: true }).click();
        await expect.poll(() => submitted?.referenceArtifactIds).toEqual([]);
      }
    });
  }
}
