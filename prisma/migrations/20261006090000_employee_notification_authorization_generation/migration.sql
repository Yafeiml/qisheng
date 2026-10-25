-- A revocation starts a new authorization generation. Credits reserved before
-- it must not be retried or refunded into a later authorization.
ALTER TABLE "employee_notification_subscriptions"
ADD COLUMN "authorization_generation" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "employee_task_notifications"
ADD COLUMN "subscription_authorization_generation" INTEGER;
