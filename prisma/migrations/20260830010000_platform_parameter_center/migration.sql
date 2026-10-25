CREATE TYPE "platform_setting_group" AS ENUM (
    'GENERAL',
    'GENERATION',
    'RETRIEVAL',
    'WORKER',
    'STORAGE',
    'PAYMENT',
    'SECURITY',
    'NOTIFICATION'
);

CREATE TYPE "platform_setting_value_type" AS ENUM (
    'STRING',
    'INTEGER',
    'DECIMAL',
    'BOOLEAN',
    'URL',
    'ENUM',
    'SECRET'
);

CREATE TABLE "platform_settings" (
    "key" VARCHAR(120) NOT NULL,
    "group" "platform_setting_group" NOT NULL,
    "value_type" "platform_setting_value_type" NOT NULL,
    "value" JSONB,
    "ciphertext" BYTEA,
    "initialization_vector" BYTEA,
    "authentication_tag" BYTEA,
    "key_version" VARCHAR(40),
    "secret_last_four" VARCHAR(4),
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("key"),
    CONSTRAINT "platform_settings_version_check" CHECK ("version" >= 1),
    CONSTRAINT "platform_settings_value_shape_check" CHECK (
        (
            "value_type" = 'SECRET'
            AND "value" IS NULL
            AND "ciphertext" IS NOT NULL
            AND "initialization_vector" IS NOT NULL
            AND "authentication_tag" IS NOT NULL
            AND "key_version" IS NOT NULL
            AND "secret_last_four" IS NOT NULL
        )
        OR
        (
            "value_type" <> 'SECRET'
            AND "value" IS NOT NULL
            AND "ciphertext" IS NULL
            AND "initialization_vector" IS NULL
            AND "authentication_tag" IS NULL
            AND "key_version" IS NULL
            AND "secret_last_four" IS NULL
        )
    )
);

CREATE INDEX "platform_settings_group_key_idx" ON "platform_settings"("group", "key");
