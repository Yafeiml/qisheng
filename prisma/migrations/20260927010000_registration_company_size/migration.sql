-- Nullable for historical applications and compatibility with the previous API.
-- New application requests must supply one of the supported sizes via API validation.
ALTER TABLE "registration_applications" ADD COLUMN "company_size" VARCHAR(32);
