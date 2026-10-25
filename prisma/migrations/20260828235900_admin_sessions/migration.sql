-- Formal SaaS administrator sessions use short-lived access tokens and rotated,
-- opaque refresh tokens. Only a SHA-256 digest of each refresh token is persisted.
CREATE TABLE "admin_sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "refresh_token_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    "revoke_reason" VARCHAR(120),
    "user_agent" VARCHAR(300),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "admin_sessions_refresh_token_hash_key"
ON "admin_sessions"("refresh_token_hash");

CREATE INDEX "admin_sessions_user_id_revoked_at_expires_at_idx"
ON "admin_sessions"("user_id", "revoked_at", "expires_at");

CREATE INDEX "admin_sessions_expires_at_idx"
ON "admin_sessions"("expires_at");

ALTER TABLE "admin_sessions"
ADD CONSTRAINT "admin_sessions_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "global_users"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
