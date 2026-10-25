CREATE TABLE "industries" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 1000,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "industries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "industries_name_key" ON "industries"("name");
CREATE INDEX "industries_sort_order_name_idx" ON "industries"("sort_order", "name");

INSERT INTO "industries" ("id", "name", "sort_order", "updated_at") VALUES
    ('industry_seed_001', '医疗健康', 100, CURRENT_TIMESTAMP),
    ('industry_seed_002', '零售消费', 200, CURRENT_TIMESTAMP),
    ('industry_seed_003', '餐饮', 300, CURRENT_TIMESTAMP),
    ('industry_seed_004', '教育培训', 400, CURRENT_TIMESTAMP),
    ('industry_seed_005', '金融服务', 500, CURRENT_TIMESTAMP),
    ('industry_seed_006', '房地产家居', 600, CURRENT_TIMESTAMP),
    ('industry_seed_007', '汽车出行', 700, CURRENT_TIMESTAMP),
    ('industry_seed_008', '旅游酒店', 800, CURRENT_TIMESTAMP),
    ('industry_seed_009', '美妆个护', 900, CURRENT_TIMESTAMP),
    ('industry_seed_010', '母婴宠物', 1000, CURRENT_TIMESTAMP),
    ('industry_seed_011', '科技互联网', 1100, CURRENT_TIMESTAMP),
    ('industry_seed_012', '制造业', 1200, CURRENT_TIMESTAMP),
    ('industry_seed_013', '文化传媒', 1300, CURRENT_TIMESTAMP),
    ('industry_seed_014', '专业服务', 1400, CURRENT_TIMESTAMP),
    ('industry_seed_015', '其他', 1500, CURRENT_TIMESTAMP);
