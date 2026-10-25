ALTER TABLE "credit_lots"
  DROP CONSTRAINT "credit_lots_balances_check";

ALTER TABLE "credit_lots"
  ADD CONSTRAINT "credit_lots_balances_check" CHECK (
    "granted_credits" >= 0
    AND "available_credits" >= 0
    AND "reserved_credits" >= 0
    AND "consumed_credits" >= 0
    AND "available_credits" + "reserved_credits" + "consumed_credits" <= "granted_credits"
  );
