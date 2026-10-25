-- Existing tenant-level uniqueness remains for compatibility. All enterprise codes,
-- including legacy values, must now be globally unique.
CREATE UNIQUE INDEX "enterprises_code_key" ON "enterprises"("code");
