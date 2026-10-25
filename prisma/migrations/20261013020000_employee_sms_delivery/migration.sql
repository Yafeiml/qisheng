ALTER TABLE "enterprise_memberships"
  ADD COLUMN "sms_notification_status" VARCHAR(32) DEFAULT 'PENDING_VERIFICATION',
  ADD COLUMN "sms_notification_phone_version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "sms_notification_status_at" TIMESTAMP(3);

ALTER TABLE "employee_task_notifications"
  ADD COLUMN "recipient_phone_version" INTEGER,
  ADD COLUMN "sms_biz_id" VARCHAR(160),
  ADD COLUMN "sms_provider_request_id" VARCHAR(160),
  ADD COLUMN "sms_delivery_status" VARCHAR(20),
  ADD COLUMN "sms_delivery_code" VARCHAR(120),
  ADD COLUMN "sms_delivered_at" TIMESTAMP(3),
  ADD COLUMN "sms_query_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "sms_next_query_at" TIMESTAMP(3);

CREATE INDEX "employee_task_notifications_sms_delivery_status_sms_next_query_at_idx"
  ON "employee_task_notifications" ("sms_delivery_status", "sms_next_query_at");
