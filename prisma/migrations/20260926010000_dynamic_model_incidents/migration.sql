CREATE TABLE "model_route_incidents" (
  "id" TEXT NOT NULL,
  "route_id" TEXT NOT NULL,
  "delivery_mode" "generation_delivery_mode" NOT NULL,
  "configuration_fingerprint" VARCHAR(64) NOT NULL,
  "qualification_id" TEXT NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "text_failures" INTEGER NOT NULL DEFAULT 0,
  "image_failures" INTEGER NOT NULL DEFAULT 0,
  "notification_status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  "notification_attempts" INTEGER NOT NULL DEFAULT 0,
  "next_notification_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "notification_lease_token" VARCHAR(64),
  "notification_lease_until" TIMESTAMP(3),
  "notification_error" VARCHAR(250),
  "notified_at" TIMESTAMP(3),
  "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_at" TIMESTAMP(3),
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "model_route_incidents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "model_route_incidents_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "model_routes"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "model_route_incidents_route_id_delivery_mode_key" ON "model_route_incidents"("route_id", "delivery_mode");
CREATE INDEX "model_route_incidents_status_notification_status_next_notific_idx" ON "model_route_incidents"("status", "notification_status", "next_notification_at");
