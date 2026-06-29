// =====================================================================
// Pengaturan aplikasi (key-value di tabel `settings`) + util jam kerja.
// Dipakai oleh: AI agent (after-hours), eskalasi, pembayaran.
// =====================================================================
import { query } from '../db/index.js';

// cache ringan agar tidak query tiap pesan; di-refresh tiap REFRESH_MS.
const REFRESH_MS = 30 * 1000;
const cache = new Map(); // key -> { value, at }

export async function getSetting(key, fallback = null) {
  const c = cache.get(key);
  if (c && Date.now() - c.at < REFRESH_MS) return c.value;
  const { rows } = await query('SELECT value FROM settings WHERE key=$1', [key]);
  const value = rows[0]?.value ?? fallback;
  cache.set(key, { value, at: Date.now() });
  return value;
}

export async function setSetting(key, value) {
  await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
    [key, JSON.stringify(value)]
  );
  cache.set(key, { value, at: Date.now() });
  return value;
}

export async function getAllSettings() {
  const { rows } = await query('SELECT key, value FROM settings ORDER BY key');
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

// Saklar global AI. Disimpan sebagai {enabled:boolean}. Toleran terhadap bentuk
// lama (boolean langsung) maupun belum diatur (default: menyala).
export async function isAiEnabled() {
  const v = await getSetting('ai_enabled', null).catch(() => null);
  if (v == null) return true;                     // belum pernah diatur -> menyala
  if (typeof v === 'object') return v.enabled !== false;
  return v !== false;                             // bentuk lama: boolean langsung
}

// Normalisasi nomor ke digit saja (untuk perbandingan allowlist yang toleran format).
function digitsOnly(p) { return String(p || '').replace(/\D/g, ''); }

// Bentuk kanonik nomor Indonesia agar '08xxx', '8xxx', dan '628xxx' dianggap sama.
// Kembalikan inti nomor tanpa awalan negara/0 (mis. '8123456789').
function canonId(p) {
  let d = digitsOnly(p);
  if (d.startsWith('62')) d = d.slice(2);
  else if (d.startsWith('0')) d = d.slice(1);
  return d;
}

// Daftar nomor yang TETAP dibalas AI walau saklar global AI dimatikan. Berguna untuk
// MENGUJI Balasan AI / Materi AI / template pada nomor tertentu (mis. nomor admin)
// tanpa menyalakan AI untuk semua pelanggan. Disimpan sebagai {numbers:[...]}.
export async function getAiAllowlist() {
  const v = await getSetting('ai_allowlist', null).catch(() => null);
  const arr = Array.isArray(v) ? v : (v && Array.isArray(v.numbers) ? v.numbers : []);
  return arr.map(digitsOnly).filter(d => d.length >= 8 && d.length <= 15);
}

// Apakah AI boleh membalas untuk customer ini?
// - Bila AI global MENYALA  -> selalu boleh (kecuali kelak ada blocklist).
// - Bila AI global MATI      -> hanya boleh bila nomornya ada di allowlist (mode uji).
export async function aiEnabledForPhone(phoneOrWaId) {
  if (await isAiEnabled()) return true;
  const d = digitsOnly(phoneOrWaId);
  if (d.length < 8) return false;
  const allow = await getAiAllowlist();
  const target = canonId(d);
  // Cocokkan via bentuk kanonik Indonesia (08/62/8 dianggap sama), dengan fallback
  // pencocokan akhiran untuk format internasional lain.
  return allow.some(a => {
    const ca = canonId(a);
    return ca === target || a === d || a.endsWith(d) || d.endsWith(a);
  });
}

// --- Jam kerja ---
// Mengembalikan {open:boolean, reason, message} berdasarkan setting 'business_hours'.
// Catatan: perhitungan zona waktu memakai TZ proses (di-set di docker-compose / env).
export async function businessHoursStatus(now = new Date()) {
  const cfg = await getSetting('business_hours', null);
  if (!cfg || cfg.enabled === false) return { open: true, reason: 'disabled' };

  // Ambil jam & hari sesuai zona waktu yang dikonfigurasi.
  const tz = cfg.tz || process.env.TZ || 'Asia/Jakarta';
  let dow, hh, mm;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(now);
    const wd = parts.find(p => p.type === 'weekday')?.value || 'Mon';
    hh = +(parts.find(p => p.type === 'hour')?.value || '0');
    mm = +(parts.find(p => p.type === 'minute')?.value || '0');
    const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    dow = map[wd] ?? now.getDay();
  } catch {
    dow = now.getDay(); hh = now.getHours(); mm = now.getMinutes();
  }

  const day = cfg.days?.[dow] || cfg.days?.[String(dow)];
  if (!day || day.closed) {
    return { open: false, reason: 'day_off', message: cfg.after_hours_message };
  }
  const cur = hh * 60 + mm;
  const [oH, oM] = String(day.open || '00:00').split(':').map(Number);
  const [cH, cM] = String(day.close || '23:59').split(':').map(Number);
  const open = cur >= (oH * 60 + oM) && cur < (cH * 60 + cM);
  return open
    ? { open: true, reason: 'within' }
    : { open: false, reason: 'after_hours', message: cfg.after_hours_message };
}
