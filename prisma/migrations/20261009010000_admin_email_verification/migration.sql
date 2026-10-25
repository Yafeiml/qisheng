BEGIN;
ALTER TABLE "admin_users"
  ADD COLUMN "email_verification_token_hash" VARCHAR(64),
  ADD COLUMN "email_verification_expires_at" TIMESTAMP(3);
CREATE UNIQUE INDEX "admin_users_email_verification_token_hash_key"
  ON "admin_users"("email_verification_token_hash");
COMMIT;
