// =====================================================================
// Broadcast terkontrol dengan RATE-LIMIT.
//
// whatsapp-web.js bersifat unofficial — blast cepat = risiko nomor diblokir.
// Maka worker ini mengirim PELAN: jeda acak antar pesan + batas per menit,
// dan hanya 1 broadcast berjalan dalam satu waktu.
//
// Konfigurasi via env:
//   BROADCAST_MIN_DELAY_MS (default 6000)  jeda minimum antar pesan
//   BROADCAST_MAX_DELAY_MS (default 12000) jeda maksimum antar pesan (jitter)
//   BROADCAST_MAX_PER_RUN  (default 500)   batas penerima per kampanye
// =====================================================================
import { query } from '../db/index.js';

const MIN_DELAY = Number(process.env.BROADCAST_MIN_DELAY_MS || 6000);
const MAX_DELAY = Number(process.env.BROADCAST_MAX_DELAY_MS || 12000);

let _sendFn = null;
let _io = null;
let _running = false; // hanya satu worker global

export function initBroadcast(io, sendFn) { _io = io; _sendFn = sendFn; }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const jitter = () => MIN_DELAY + Math.floor(Math.random() * Math.max(1, MAX_DELAY - MIN_DELAY));

// Jalankan worker bila ada broadcast 'running' dan tidak ada worker aktif.
export async function tickBroadcast() {
  if (_running) return;
  const bc = (await query(
    `SELECT * FROM broadcasts WHERE status='running' ORDER BY id ASC LIMIT 1`
  )).rows[0];
  if (!bc) return;

  _running = true;
  try {
    // Proses satu-per-satu agar mudah di-pause dan tetap pelan.
    // Loop selama broadcast masih 'running'.
    while (true) {
      const fresh = (await query('SELECT status, session FROM broadcasts WHERE id=$1', [bc.id])).rows[0];
      if (!fresh || fresh.status !== 'running') break;

      const t = (await query(
        `SELECT bt.*, cu.name AS cust_name FROM broadcast_targets bt
           LEFT JOIN customers cu ON cu.id=bt.customer_id
          WHERE bt.broadcast_id=$1 AND bt.status='queued' ORDER BY bt.id ASC LIMIT 1`,
        [bc.id]
      )).rows[0];

      if (!t) {
        // selesai
        await query(
          `UPDATE broadcasts SET status='done', finished_at=now() WHERE id=$1`, [bc.id]);
        _io?.emit('broadcast:update', { id: bc.id, status: 'done' });
        break;
      }

      // Render variabel template: {nama} -> nama customer (atau 'kak' bila kosong).
      const nama = (t.cust_name || '').trim() || 'kak';
      const text = String(bc.body)
        .replace(/\{nama\}/gi, nama)
        .replace(/\{name\}/gi, nama);

      try {
        await _sendFn(fresh.session, t.wa_id, text);
        await query(`UPDATE broadcast_targets SET status='sent', sent_at=now() WHERE id=$1`, [t.id]);
        await query(`UPDATE broadcasts SET sent=sent+1 WHERE id=$1`, [bc.id]);
      } catch (e) {
        await query(`UPDATE broadcast_targets SET status='failed', error=$2 WHERE id=$1`, [t.id, e.message]);
        await query(`UPDATE broadcasts SET failed=failed+1 WHERE id=$1`, [bc.id]);
      }
      _io?.emit('broadcast:progress', { id: bc.id });

      await sleep(jitter()); // <<< rate-limit: jeda acak antar pesan
    }
  } catch (e) {
    console.error('[broadcast] worker error:', e.message);
  } finally {
    _running = false;
  }
}

export function isRunning() { return _running; }

// Aktifkan broadcast terjadwal yang waktunya sudah tiba: 'scheduled' -> 'running'.
// Dipanggil scheduler (lifecycle). Setelah aktif, worker akan memprosesnya.
export async function activateDueBroadcasts() {
  const { rows } = await query(
    `UPDATE broadcasts SET status='running'
      WHERE status='scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= now()
      RETURNING id`);
  if (rows.length) {
    for (const r of rows) _io?.emit('broadcast:update', { id: r.id, status: 'running' });
    tickBroadcast().catch(() => {});
  }
  return rows.length;
}
