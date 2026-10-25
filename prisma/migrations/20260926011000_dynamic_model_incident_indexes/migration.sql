-- Align PostgreSQL's identifier truncation with Prisma's generated index name.
ALTER INDEX "model_route_incidents_status_notification_status_next_notific_i"
  RENAME TO "model_route_incidents_status_notification_status_next_notif_idx";
