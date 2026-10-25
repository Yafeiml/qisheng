-- Additive fields preserve old WeChat notifications and old API/Worker inserts.
-- A verified phone snapshot prevents pending sends from following a reassigned number.
ALTER TABLE "employee_task_notifications"
ADD COLUMN "channel" VARCHAR(32) NOT NULL DEFAULT 'WECHAT_TEMPLATE',
ADD COLUMN "recipient_phone" VARCHAR(32),
ADD COLUMN "recipient_phone_verified_at" TIMESTAMP(3),
ADD COLUMN "last_attempt_at" TIMESTAMP(3);
