CREATE TABLE "registration_applications" (
    "id" TEXT NOT NULL,
    "contact_name" VARCHAR(80) NOT NULL,
    "phone" VARCHAR(11) NOT NULL,
    "company_name" VARCHAR(160) NOT NULL,
    "message" VARCHAR(500),
    "status" VARCHAR(20) NOT NULL DEFAULT 'NEW',
    "notification_status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "notification_error" VARCHAR(200),
    "notified_phones" JSONB NOT NULL DEFAULT '[]',
    "notified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "registration_applications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "registration_applications_created_at_id_idx" ON "registration_applications"("created_at", "id");
CREATE INDEX "registration_applications_phone_created_at_idx" ON "registration_applications"("phone", "created_at");
