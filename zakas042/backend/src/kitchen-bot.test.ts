import { describe, it, expect } from "vitest";
import { formatKitchenReport, formatKitchenOverview } from "./bot/kitchen-bot.js";
import type { KitchenReport } from "./services/kitchen.js";

describe("Kitchen Bot formatters", () => {
  it("formats empty kitchen report correctly", () => {
    const emptyReport: KitchenReport = {
      date: "2026-09-18",
      totalGuests: 0,
      totalAdults: 0,
      totalChildren: 0,
      staying: 0,
      arriving: 0,
      rooms: [],
    };

    const formatted = formatKitchenReport(emptyReport, false);
    expect(formatted).toContain("BUGUNGI OSHXONA HISOBOTI");
    expect(formatted).toContain("2026-09-18");
    expect(formatted).toContain("0 nafar");
    expect(formatted).toContain("Ovqat bilan bron qilingan xonalar mavjud emas");
  });

  it("formats populated kitchen report with room breakdown", () => {
    const mockReport: KitchenReport = {
      date: "2026-09-18",
      totalGuests: 5,
      totalAdults: 4,
      totalChildren: 1,
      staying: 1,
      arriving: 1,
      rooms: [
        {
          roomId: "101",
          roomLabel: "Komfort 3 kishilik",
          adults: 2,
          children: 1,
          guestName: "Alisher Navoiy",
          source: "Sayt",
          arriving: false,
        },
        {
          roomId: "204",
          roomLabel: "Premium 4 kishilik",
          adults: 2,
          children: 0,
          guestName: "Zahiriddin Bobur",
          source: "Booking.com",
          arriving: true,
        },
      ],
    };

    const formatted = formatKitchenReport(mockReport, false);
    expect(formatted).toContain("Jami mehmonlar: <b>5 nafar</b>");
    expect(formatted).toContain("Kattalar: <b>4</b>");
    expect(formatted).toContain("Bolalar: <b>1</b>");
    expect(formatted).toContain("Xona 101");
    expect(formatted).toContain("Alisher Navoiy");
    expect(formatted).toContain("Porsiya: <b>3 ta</b> (2 katta, 1 bola)");
    expect(formatted).toContain("Xona 204");
    expect(formatted).toContain("Zahiriddin Bobur");
    expect(formatted).toContain("Porsiya: <b>2 ta</b> (2 katta)");
  });

  it("formats tomorrow report with appropriate header and arrival labels", () => {
    const mockReport: KitchenReport = {
      date: "2026-09-19",
      totalGuests: 2,
      totalAdults: 2,
      totalChildren: 0,
      staying: 0,
      arriving: 1,
      rooms: [
        {
          roomId: "105",
          roomLabel: "Oilaviy yarim lyuks",
          adults: 2,
          children: 0,
          guestName: "Mirzo Ulug'bek",
          source: "Qabulxona",
          arriving: true,
        },
      ],
    };

    const formatted = formatKitchenReport(mockReport, true);
    expect(formatted).toContain("ERTANGI OSHXONA HISOBOTI");
    expect(formatted).toContain("Ertaga keladi");
    expect(formatted).toContain("Mirzo Ulug'bek");
  });
});
