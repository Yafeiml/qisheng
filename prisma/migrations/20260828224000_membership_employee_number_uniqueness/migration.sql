-- Employee numbers are optional, but a non-null number identifies at most one
-- membership inside an enterprise. PostgreSQL unique indexes permit multiple
-- NULL values, which preserves memberships without employee numbers.
CREATE UNIQUE INDEX "enterprise_memberships_enterprise_id_employee_no_key"
ON "enterprise_memberships"("enterprise_id", "employee_no");
