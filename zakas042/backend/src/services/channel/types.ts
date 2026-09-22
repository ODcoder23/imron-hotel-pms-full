/**
 * ChannelAdapter interfeysi — TZ 12-band
 *
 * Manba: 01-ARXITEKTURA-VA-QOIDALAR.md §4
 *
 * TZ: "Arxitektura faqat Beds24 bilan cheklanmasin... Bronevik,
 * MyBooking kabi kanallarni qo'shish mumkin bo'ladigan qilib yozilsin."
 *
 * Bu fayl — CHEGARA. Biznes-mantiq qatlami faqat shu interfeysni
 * biladi, "Beds24" nomini hech qayerda qattiq yozmaydi.
 *
 * Kelajakda `BronevikAdapter` qo'shilsa — sync queue, mapping va
 * status-mapping mantig'i qayta yozilmaydi, faqat yangi adapter
 * ulanadi.
 */

// --- Tashqi kanaldan keladigan bron (TZ 1-band maydonlari) --
export type ExternalReservation = {
  externalId: string;
  externalRoomTypeId: string;
  externalUnitId?: string;
  status: string;                  // kanal o'z atamasi — statusMap tarjima qiladi
  subStatus?: string;
  checkIn: string;                 // "YYYY-MM-DD"
  checkOut: string;
  adults: number;
  children: number;
  price: number;
  currency: string;
  guest: {
    fullName: string;
    phone?: string;
    email?: string;
    country?: string;
    address?: string;
  };
  notes?: string;
  source?: string;                 // "Booking.com", "Airbnb" — referer'dan
  payments?: Array<{ amount: number; description?: string; externalId?: string }>;
  modifiedAt: string;              // ISO — polling filtri uchun
  /** Bizning o'z aks-sadomizmi (04-fayl §6 echo loop himoyasi) */
  isOwnEcho?: boolean;
};

// --- Kanaldagi room type (mapping ekrani uchun) -------------
export type ExternalRoomType = {
  id: string;
  name: string;
  /** Shu turdagi xonalar soni — agregatsiya tekshiruvi uchun (07-fayl §2) */
  qty: number;
  maxPeople?: number;
  /** Unit-level mapping mavjudmi (06-fayl §2, Daraja 2) */
  units: Array<{ id: string; name: string }>;
};

export type ExternalProperty = {
  id: string;
  name: string;
  currency: string;
  roomTypes: ExternalRoomType[];
};

// --- Sync natijasi ------------------------------------------
export type SyncResult =
  | { ok: true; externalId?: string; detail?: string }
  | { ok: false; error: string; retryable: boolean; retryAfterSeconds?: number };

export type WebhookResult = {
  event: string;
  externalId: string | null;
  reservation?: ExternalReservation;
  /** Bizning aks-sadomiz — e'tiborsiz qoldiriladi */
  isOwnEcho: boolean;
};

// --- Availability / rates yuborish payload'i ----------------
export type AvailabilityPush = {
  externalRoomTypeId: string;
  days: Array<{ date: string; available: number }>;
};

export type RatesPush = {
  externalRoomTypeId: string;
  days: Array<{ date: string; price: number; minStay?: number }>;
};

/**
 * Kanal adapteri.
 *
 * `MockAdapter` va `Beds24Adapter` — ikkalasi ham shu interfeysni
 * bajaradi. Test mock bilan, production haqiqiy kanal bilan ishlaydi,
 * kod bir xil.
 */
export interface ChannelAdapter {
  /** Kanal kodi — `Channel.code` bilan mos (`"beds24"`) */
  readonly code: string;

  /** Ulanish tekshiruvi. FAZA 15 `beds24:verify` shuni chaqiradi */
  ping(): Promise<{ ok: boolean; detail: string; creditsRemaining?: number }>;

  /** Room type ro'yxati — mapping ekrani uchun (06-fayl §3) */
  getRoomTypes(): Promise<ExternalProperty[]>;

  /** O'zgargan bronlarni tortish — polling fallback (04-fayl §8) */
  pullReservations(since: Date): Promise<ExternalReservation[]>;

  /** Bronni kanalga yuborish (TZ 2-band, 12-fayl §3) */
  pushReservation(payload: {
    externalId?: string;
    externalRoomTypeId: string;
    externalUnitId?: string;
    status: string;
    subStatus?: string;
    checkIn: string;
    checkOut: string;
    adults: number;
    children: number;
    totalPrice: number;
    guestFirstName: string;
    guestLastName: string;
    phone?: string;
    email?: string;
    notes?: string;
  }): Promise<SyncResult>;

  /** Availability yuborish (TZ 6-band, 07-fayl §4) */
  pushAvailability(payload: AvailabilityPush): Promise<SyncResult>;

  /** Narx yuborish (TZ 7-band) */
  pushRates(payload: RatesPush): Promise<SyncResult>;

  /** Joriy availability'ni o'qish — drift tekshiruvi (07-fayl §6) */
  getAvailability(
    externalRoomTypeId: string,
    from: string,
    to: string
  ): Promise<Array<{ date: string; available: number; price?: number }>>;

  /** Kiruvchi webhook'ni normallashtirish (04-fayl) */
  parseWebhook(payload: unknown): WebhookResult;
}
