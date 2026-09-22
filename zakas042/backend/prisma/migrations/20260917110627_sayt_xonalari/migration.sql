-- AlterTable
ALTER TABLE "RoomType" ADD COLUMN     "amenities" JSONB,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "gallery" JSONB,
ADD COLUMN     "imageUrl" TEXT,
ADD COLUMN     "showOnSite" BOOLEAN NOT NULL DEFAULT true;

