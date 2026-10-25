ALTER TABLE "usage_ledgers"
DROP CONSTRAINT "usage_ledgers_positive_amount_check";

ALTER TABLE "usage_ledgers"
ADD CONSTRAINT "usage_ledgers_amount_check" CHECK (
    (
        "type" = 'ADJUST'
        AND "amount" <> 0
    )
    OR (
        "type" <> 'ADJUST'
        AND "amount" > 0
    )
);
