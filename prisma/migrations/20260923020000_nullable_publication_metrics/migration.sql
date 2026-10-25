-- Unknown page metrics must be stored as NULL; preserve all existing observed values.
ALTER TABLE "publish_metric_snapshots"
  ALTER COLUMN "views" DROP DEFAULT,
  ALTER COLUMN "views" DROP NOT NULL,
  ALTER COLUMN "likes" DROP DEFAULT,
  ALTER COLUMN "likes" DROP NOT NULL,
  ALTER COLUMN "comments" DROP DEFAULT,
  ALTER COLUMN "comments" DROP NOT NULL,
  ALTER COLUMN "favorites" DROP DEFAULT,
  ALTER COLUMN "favorites" DROP NOT NULL,
  ALTER COLUMN "shares" DROP DEFAULT,
  ALTER COLUMN "shares" DROP NOT NULL;
