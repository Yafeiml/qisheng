ALTER TABLE "recharge_orders"
  ADD COLUMN "payment_out_trade_no" VARCHAR(32),
  ADD COLUMN "payment_app_id" VARCHAR(32),
  ADD COLUMN "payment_merchant_id" VARCHAR(32),
  ADD COLUMN "payment_description" VARCHAR(127),
  ADD COLUMN "payment_notify_url" VARCHAR(500),
  ADD COLUMN "payment_code_url" VARCHAR(512),
  ADD COLUMN "payment_transaction_id" VARCHAR(64),
  ADD COLUMN "payment_lease_token" VARCHAR(36),
  ADD COLUMN "payment_lease_until" TIMESTAMP(3),
  ADD COLUMN "payment_next_check_at" TIMESTAMP(3),
  ADD COLUMN "payment_checked_at" TIMESTAMP(3),
  ADD COLUMN "payment_last_error" VARCHAR(80);
CREATE UNIQUE INDEX "recharge_orders_payment_out_trade_no_key" ON "recharge_orders"("payment_out_trade_no");
CREATE UNIQUE INDEX "recharge_orders_payment_transaction_id_key" ON "recharge_orders"("payment_transaction_id");
CREATE INDEX "recharge_orders_status_payment_next_check_at_idx" ON "recharge_orders"("status", "payment_next_check_at");
