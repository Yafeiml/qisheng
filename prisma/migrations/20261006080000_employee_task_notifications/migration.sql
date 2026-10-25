-- CreateTable
CREATE TABLE "wechat_miniapp_identities" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "app_id" VARCHAR(32) NOT NULL,
    "open_id" VARCHAR(128) NOT NULL,
    "union_id" VARCHAR(128),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wechat_miniapp_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_notification_subscriptions" (
    "id" TEXT NOT NULL,
    "identity_id" TEXT NOT NULL,
    "template_id" VARCHAR(160) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'NONE',
    "remaining_subscriptions" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "last_authorized_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_notification_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_subscription_requests" (
    "id" VARCHAR(64) NOT NULL,
    "identity_id" TEXT NOT NULL,
    "template_id" VARCHAR(160) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_subscription_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_task_notifications" (
    "id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "event" VARCHAR(32) NOT NULL DEFAULT 'NEW_TASK',
    "user_id" TEXT NOT NULL,
    "app_id" VARCHAR(32) NOT NULL,
    "template_id" VARCHAR(160) NOT NULL,
    "identity_id" TEXT,
    "subscription_id" TEXT,
    "identity_version" INTEGER NOT NULL DEFAULT 1,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_token" VARCHAR(64),
    "lease_until" TIMESTAMP(3),
    "error_code" VARCHAR(120),
    "subscription_reserved" BOOLEAN NOT NULL DEFAULT false,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_task_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wechat_miniapp_identities_user_id_app_id_key" ON "wechat_miniapp_identities"("user_id", "app_id");

-- CreateIndex
CREATE UNIQUE INDEX "wechat_miniapp_identities_app_id_open_id_key" ON "wechat_miniapp_identities"("app_id", "open_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_notification_subscriptions_identity_id_template_id_key" ON "employee_notification_subscriptions"("identity_id", "template_id");

-- CreateIndex
CREATE INDEX "employee_subscription_requests_identity_id_created_at_idx" ON "employee_subscription_requests"("identity_id", "created_at");

-- CreateIndex
CREATE INDEX "employee_task_notifications_status_next_attempt_at_idx" ON "employee_task_notifications"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "employee_task_notifications_user_id_created_at_idx" ON "employee_task_notifications"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "employee_task_notifications_task_id_event_key" ON "employee_task_notifications"("task_id", "event");

-- AddForeignKey
ALTER TABLE "wechat_miniapp_identities" ADD CONSTRAINT "wechat_miniapp_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "global_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_notification_subscriptions" ADD CONSTRAINT "employee_notification_subscriptions_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "wechat_miniapp_identities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_subscription_requests" ADD CONSTRAINT "employee_subscription_requests_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "wechat_miniapp_identities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_task_notifications" ADD CONSTRAINT "employee_task_notifications_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "distribution_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_task_notifications" ADD CONSTRAINT "employee_task_notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "global_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_task_notifications" ADD CONSTRAINT "employee_task_notifications_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "wechat_miniapp_identities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_task_notifications" ADD CONSTRAINT "employee_task_notifications_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "employee_notification_subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

