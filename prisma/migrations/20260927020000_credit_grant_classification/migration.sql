DO $classification$
BEGIN
PERFORM set_config('lock_timeout', '5s', true);
-- Keep concurrent grants from changing the lot totals while counters are corrected.
LOCK TABLE "credit_wallets", "credit_lots" IN SHARE ROW EXCLUSIVE MODE;

WITH totals AS (
  SELECT "wallet_id",
    SUM("granted_credits") AS granted,
    COALESCE(SUM("granted_credits") FILTER (WHERE "source" = 'PURCHASE'), 0) AS purchased,
    COALESCE(SUM("granted_credits") FILTER (WHERE "source" IN ('BONUS', 'OPENING', 'ADJUSTMENT')), 0) AS bonus
  FROM "credit_lots"
  GROUP BY "wallet_id"
)
UPDATE "credit_wallets" AS wallet
SET "lifetime_purchased" = totals.purchased,
    "lifetime_bonus" = totals.bonus
FROM totals
WHERE wallet."id" = totals."wallet_id"
  AND wallet."lifetime_granted" = totals.granted
  AND (wallet."lifetime_purchased" <> totals.purchased OR wallet."lifetime_bonus" <> totals.bonus);

-- No balance, ownership, lot, order or ledger is changed, and no credits are issued.
END
$classification$;
