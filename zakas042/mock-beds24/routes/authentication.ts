/**
 * /authentication/* — 03-BEDS24-API-INTEGRATSIYA.md §1
 *
 * Haqiqiy oqim:
 *   1. Panelda invite code yaratiladi
 *   2. GET /authentication/setup  (header: code) -> refreshToken
 *   3. GET /authentication/token  (header: refreshToken) -> access token
 *   4. Keyingi so'rovlarda header: token
 */

import { Router } from "express";
import { state } from "../state.js";

export const authRouter = Router();

/** Mock: bu invite code'lar qabul qilinadi */
const VALID_INVITE_CODES = new Set(["mock-invite-code", "test123", "imron-setup"]);

authRouter.get("/setup", (req, res) => {
  const code = req.header("code");

  if (!code) {
    res.status(400).json({ error: "Missing 'code' header" });
    return;
  }
  if (!VALID_INVITE_CODES.has(code)) {
    res.status(403).json({ error: "Invalid invite code" });
    return;
  }

  const refreshToken = `mock-refresh-${Math.random().toString(36).slice(2, 14)}`;
  const rec = state.createToken(refreshToken);

  res.json({
    token: rec.token,
    expiresIn: 86400,
    refreshToken: rec.refreshToken,
  });
});

authRouter.get("/token", (req, res) => {
  const refreshToken = req.header("refreshToken");

  if (!refreshToken) {
    res.status(400).json({ error: "Missing 'refreshToken' header" });
    return;
  }
  if (!refreshToken.startsWith("mock-refresh-")) {
    res.status(401).json({ error: "Invalid refresh token" });
    return;
  }

  const rec = state.createToken(refreshToken);
  res.json({ token: rec.token, expiresIn: 86400 });
});
