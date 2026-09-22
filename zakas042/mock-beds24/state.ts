/**
 * Mock server holati — xotirada
 *
 * Manba: 03-BEDS24-API-INTEGRATSIYA.md §1 (auth), §3 (rate limit)
 *
 * Bu Beds24'ning haqiqiy xatti-harakatini taqlid qiladi:
 *   - token 24 soat amal qiladi
 *   - kredit 5 daqiqalik aylanma oynada sarflanadi
 *   - har javobda rate-limit headerlari qaytadi
 */

export type Booking = {
  id: number;
  roomId: number;
  unitId?: number;
  status: "new" | "request" | "confirmed" | "cancelled" | "black";
  subStatus?: "arrived" | "departed";
  arrival: string;          // "YYYY-MM-DD"
  departure: string;
  numAdult: number;
  numChild: number;
  price: number;
  firstName: string;
  lastName: string;
  phone?: string;
  email?: string;
  notes?: string;
  referer?: string;         // "PMS" — echo loop himoyasi uchun
  bookingTime: string;      // ISO
  modifiedTime: string;     // ISO — modifiedFrom filtri uchun
  invoiceItems?: Array<{ type: string; amount: number; description: string }>;
};

export type CalendarEntry = {
  roomId: number;
  from: string;
  to: string;
  numAvail?: number;
  price1?: number;
  minStay?: number;
};

/** Kredit hisobi — 5 daqiqalik aylanma oyna */
class CreditWindow {
  private used = 0;
  private windowStart = Date.now();
  readonly limit: number;

  constructor(limit = 100) {
    this.limit = limit;
  }

  /** So'rov qiymatini yechadi. false = kredit tugagan */
  spend(cost: number): boolean {
    this.rotateIfNeeded();
    if (this.used + cost > this.limit) return false;
    this.used += cost;
    return true;
  }

  get remaining(): number {
    this.rotateIfNeeded();
    return Math.max(0, this.limit - this.used);
  }

  /** Oyna qayta boshlanishiga qancha soniya qoldi */
  get resetsIn(): number {
    this.rotateIfNeeded();
    const elapsed = (Date.now() - this.windowStart) / 1000;
    return Math.max(0, Math.ceil(300 - elapsed));
  }

  private rotateIfNeeded(): void {
    if (Date.now() - this.windowStart >= 300_000) {
      this.used = 0;
      this.windowStart = Date.now();
    }
  }

  /** Test uchun: kreditni sun'iy tugatish */
  drain(): void {
    this.used = this.limit;
  }

  reset(): void {
    this.used = 0;
    this.windowStart = Date.now();
  }
}

/** Token — 24 soat amal qiladi (03-fayl §1) */
type TokenRecord = { token: string; refreshToken: string; expiresAt: number };

class MockState {
  credits = new CreditWindow(Number(process.env.MOCK_CREDIT_LIMIT ?? 100));
  tokens = new Map<string, TokenRecord>();
  bookings = new Map<number, Booking>();
  calendar = new Map<string, CalendarEntry>();   // kalit: `${roomId}:${date}`
  nextBookingId = 70000001;

  /** Yuborilgan webhook'lar tarixi — test tekshiruvi uchun */
  webhooksSent: Array<{ at: string; event: string; bookingId: number }> = [];

  /** Qabul qilingan calendar so'rovlari — test tekshiruvi uchun */
  calendarPushes: Array<{ at: string; roomId: number; entries: CalendarEntry[] }> = [];

  createToken(refreshToken: string): TokenRecord {
    const rec: TokenRecord = {
      token: `mock-access-${Math.random().toString(36).slice(2, 12)}`,
      refreshToken,
      expiresAt: Date.now() + 24 * 3600 * 1000,
    };
    this.tokens.set(rec.token, rec);
    return rec;
  }

  isTokenValid(token: string | undefined): boolean {
    if (!token) return false;
    const rec = this.tokens.get(token);
    return rec !== undefined && rec.expiresAt > Date.now();
  }

  addBooking(b: Omit<Booking, "id" | "bookingTime" | "modifiedTime">): Booking {
    const now = new Date().toISOString();
    const booking: Booking = {
      ...b,
      id: this.nextBookingId++,
      bookingTime: now,
      modifiedTime: now,
    };
    this.bookings.set(booking.id, booking);
    return booking;
  }

  updateBooking(id: number, patch: Partial<Booking>): Booking | null {
    const existing = this.bookings.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...patch, modifiedTime: new Date().toISOString() };
    this.bookings.set(id, updated);
    return updated;
  }

  setCalendar(entries: CalendarEntry[]): void {
    for (const e of entries) {
      // Oraliqni kunlarga yoyish
      const from = new Date(e.from + "T00:00:00Z");
      const to = new Date(e.to + "T00:00:00Z");
      for (let d = new Date(from); d <= to; d.setUTCDate(d.getUTCDate() + 1)) {
        const key = `${e.roomId}:${d.toISOString().slice(0, 10)}`;
        const prev = this.calendar.get(key);
        this.calendar.set(key, {
          roomId: e.roomId,
          from: d.toISOString().slice(0, 10),
          to: d.toISOString().slice(0, 10),
          numAvail: e.numAvail ?? prev?.numAvail,
          price1: e.price1 ?? prev?.price1,
          minStay: e.minStay ?? prev?.minStay,
        });
      }
    }
  }

  getCalendar(roomId: number, from: string, to: string): CalendarEntry[] {
    const out: CalendarEntry[] = [];
    const start = new Date(from + "T00:00:00Z");
    const end = new Date(to + "T00:00:00Z");
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const key = `${roomId}:${d.toISOString().slice(0, 10)}`;
      const e = this.calendar.get(key);
      if (e) out.push(e);
    }
    return out;
  }

  /** Testlar orasida tozalash */
  reset(): void {
    this.credits.reset();
    this.bookings.clear();
    this.calendar.clear();
    this.webhooksSent = [];
    this.calendarPushes = [];
    this.nextBookingId = 70000001;
  }
}

export const state = new MockState();
