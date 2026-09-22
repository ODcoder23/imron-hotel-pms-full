/**
 * GET /properties — 03-fayl §2
 *
 * Mapping ekrani shu javobdan room type ro'yxatini oladi (06-fayl §3).
 * Kamdan-kam o'zgaradi, shuning uchun PMS tomonda cache qilinadi.
 */

import { Router } from "express";
import { properties } from "../fixtures/properties.js";

export const propertiesRouter = Router();

propertiesRouter.get("/", (_req, res) => {
  res.json({ success: true, data: properties });
});
