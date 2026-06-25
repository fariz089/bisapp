// =====================================================================
// Siklus sesi otomatis: follow-up saat customer diam, lalu auto-close.
//
// Aturan (semua dapat dikonfigurasi via env, default sesuai keputusan owner):
//  - FOLLOWUP_AFTER_MIN  (default 3): bila customer diam selama N menit dan
//    pesan terakhir BUKAN dari customer belum dibalas, AI mengirim 1 nudge halus.
//  - CLOSE_AFTER_MIN     (default 5): bila tetap diam total N menit sejak pesan
//    terakhir customer, sesi ditutup otomatis (status 'resolved').
//  - MAX_FOLLOWUPS       (default 1): jumlah nudge maksimum sebelum auto-close.
//
// Berlaku untuk mode 'ai' MAUPUN 'human':
//  - mode ai    -> AI mengirim nudge & pesan penutup, lalu evaluasi tidak dijalankan
//                  (karena tak ada karyawan yang terlibat) kecuali memang ada agent.
//  - mode human -> AI tetap mengirim nudge ke customer DAN memberi tahu karyawan
//                  via socket ('conversation:nudge'); bila tetap diam, sesi ditutup.
//
// Scheduler dijalankan via setInterval di server.js. Tidak perlu service tambahan.
// =====================================================================

import { query } from '../db/index.js';
import { randomUUID } from 'crypto';
import { followupMessage, evaluateAgent } from './llm.js';
import { getHistory } from './conversation.js';
import { expireOverdue } from './payments.js';
import { reapStalePresence } from './escalation.js';
import { tickBroadcast, activateDueBroadcasts } from './broadcast.js';
import { getSetting, isAiEnabled } from './settings.js';
import { backfillSentimentBatch } from './sentiment.js';

const PUBLIC_URL = process.env.PUBLIC_URL || '';

const MIN = 60 * 1000;
const FOLLOWUP_AFTER_MIN = Number(process.env.FOLLOWUP_AFTER_MIN || 3);
const CLOSE_AFTER_MIN = Number(process.env.CLOSE_AFTER_MIN || 5);
const MAX_FOLLOWUPS = Number(process.env.MAX_FOLLOWUPS || 1);
const TICK_SEC = Number(process.env.LIFECYCLE_TICK_SEC || 30); // seberapa sering memindai

// Pesan penutup standar (ramah). Boleh diganti via env.
const CLOSING_TEXT = process.env.CLOSING_TEXT ||
  'Karena belum ada balasan, percakapan ini kami tutup dulu ya kak 🙏 ' +
  'Jika masih butuh bantuan, silakan chat lagi kapan saja — kami siap membantu. Terima kasih!';

let _io = null;
let _sendFn = null;
let _timer = null;

// Tutup sesi: tandai resolved + alasan, evaluasi karyawan bila ada, beri tahu dashboard.
async function closeConversation(convo, reason) {
  await query(
    `UPDATE conversations SET status='resolved', resolved_at=now(), close_reason=$2 WHERE id=$1`,
    [convo.id, reason]
  );
  _io?.emit('conversation:closed', { conversationId: convo.id, reason });
  _io?.emit('conversation:update', { conversationId: convo.id });

  // Bila percakapan sempat ditangani karyawan, jalankan evaluasi KPI (sama seperti resolve manual)
  if (convo.assigned_agent) {
    try {
      const history = await getHistory(convo.id, 40);
      const ev = await evaluateAgent(history);
      await query(
        `INSERT INTO agent_evaluations
           (conversation_id, agent_id, score_politeness, score_clarity, score_helpfulness, score_speed, summary)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [convo.id, convo.assigned_agent, ev.politeness, ev.clarity, ev.helpfulness, ev.speed, ev.summary]
      );
    } catch (e) { console.error('[lifecycle] evaluasi gagal:', e.message); }

    // Minta rating CSAT dari customer (hanya untuk sesi yang melibatkan agen).
    try {
      const csat = await getSetting('csat', {});
      if (csat.enabled !== false) {
        const token = randomUUID().slice(0, 12);
        await query(`UPDATE conversations SET csat_token=$2 WHERE id=$1`, [convo.id, token]);
        const link = PUBLIC_URL ? `${PUBLIC_URL.replace(/\/$/, '')}/rate/${token}` : '';
        const ask = (csat.ask_message || 'Boleh beri penilaian layanan kami (1-5)? ') + (link || '');
        await sendCsatMessage(convo, ask.trim());
      }
    } catch (e) { console.error('[lifecycle] csat gagal:', e.message); }
  }
}

// Kirim pesan permintaan CSAT (terpisah agar tidak mereset last_sender ke 'ai' yang memicu nudge).
async function sendCsatMessage(convo, text) {
  try { await _sendFn(convo.session, convo.wa_id, text); }
  catch (e) { console.error('[lifecycle] gagal kirim csat WA:', e.message); return; }
  const { rows } = await query(
    `INSERT INTO messages (conversation_id, account_id, direction, sender_type, body)
     VALUES ($1,$2,'out','ai',$3) RETURNING *`,
    [convo.id, convo.account_id, text]
  );
  if (rows[0]) _io?.emit('message:new', { conversationId: convo.id, accountId: convo.account_id, message: rows[0] });
}

// Simpan pesan keluar dari sistem/AI (nudge atau penutup) ke transkrip + kirim WA.
async function sendSystemMessage(convo, text, kind) {
  // kind: 'followup' | 'closing'  (hanya untuk log; sender_type tetap 'ai')
  try {
    await _sendFn(convo.session, convo.wa_id, text);
  } catch (e) {
    console.error(`[lifecycle] gagal kirim ${kind} WA:`, e.message);
    return; // jangan catat pesan bila gagal terkirim
  }
  const { rows } = await query(
    `INSERT INTO messages (conversation_id, account_id, direction, sender_type, body)
     VALUES ($1,$2,'out','ai',$3) RETURNING *`,
    [convo.id, convo.account_id, text]
  );
  // pesan dari AI -> tandai last_sender bukan customer
  await query(`UPDATE conversations SET last_message_at=now(), last_sender='ai' WHERE id=$1`, [convo.id]);
  if (rows[0]) _io?.emit('message:new', { conversationId: convo.id, accountId: convo.account_id, message: rows[0] });
}

// Satu putaran pemindaian.
async function tick() {
  try {
    // Ambil percakapan terbuka yang pesan terakhirnya BUKAN dari customer
    // (artinya kita sedang menunggu balasan customer), beserta data kirim WA.
    const { rows } = await query(
      `SELECT c.id, c.account_id, c.mode, c.status, c.assigned_agent,
              c.followups_sent, c.last_sender,
              EXTRACT(EPOCH FROM (now()-c.last_message_at)) AS idle_sec,
              a.session, cu.wa_id
         FROM conversations c
         JOIN wa_accounts a ON a.id=c.account_id
         JOIN customers cu ON cu.id=c.customer_id
        WHERE c.status <> 'resolved'
          AND c.last_sender <> 'customer'
        ORDER BY c.last_message_at ASC
        LIMIT 50`
    );

    // Saklar global AI: bila dimatikan, AI tidak mengirim nudge maupun pesan
    // penutup ke customer. Sesi tetap di-auto-close agar tidak menggantung.
    const aiEnabled = await isAiEnabled();

    for (const convo of rows) {
      const idleMin = convo.idle_sec / 60;

      // 1) Sudah waktunya auto-close?
      if (idleMin >= CLOSE_AFTER_MIN) {
        // kirim penutup hanya bila AI aktif & masih ada koneksi WA; kalau gagal, tetap tutup.
        if (aiEnabled) {
          await sendSystemMessage(convo, CLOSING_TEXT, 'closing').catch(() => {});
        }
        await closeConversation(convo, convo.assigned_agent ? 'timeout' : 'resolved_by_ai');
        continue;
      }

      // 2) Sudah waktunya nudge & belum melebihi batas? (lewati bila AI dimatikan)
      if (aiEnabled && idleMin >= FOLLOWUP_AFTER_MIN && convo.followups_sent < MAX_FOLLOWUPS) {
        const history = await getHistory(convo.id, 12);
        const text = await followupMessage(history).catch(() =>
          'Halo kak, masih di sini? 😊 Ada lagi yang bisa kami bantu soal tiket atau sewa busnya?');
        await sendSystemMessage(convo, text, 'followup');
        await query(
          `UPDATE conversations SET followups_sent=followups_sent+1, last_followup_at=now() WHERE id=$1`,
          [convo.id]
        );
        // beri tahu karyawan bila percakapan dalam mode human (menunggu agent)
        if (convo.mode === 'human') {
          _io?.emit('conversation:nudge', { conversationId: convo.id, accountId: convo.account_id });
        }
      }
    }
  } catch (e) {
    console.error('[lifecycle] tick error:', e.message);
  }
}

// ---- Pengingat keberangkatan H-1 (AKAP) ----
// Mencari booking AKAP yang berangkat BESOK, belum diingatkan, lalu kirim WA.
async function remindDepartures() {
  try {
    const { rows } = await query(
      `SELECT b.id, b.code, b.seat_numbers, a.session, cu.wa_id, cu.name,
              r.origin, r.destination, s.departure_date, s.departure_time
         FROM bookings b
         JOIN schedules s ON s.id=b.schedule_id
         JOIN routes r ON r.id=s.route_id
         JOIN customers cu ON cu.id=b.customer_id
         JOIN conversations c ON c.id=b.conversation_id
         JOIN wa_accounts a ON a.id=c.account_id
        WHERE b.service_type='akap'
          AND b.status IN ('confirmed','paid')
          AND b.reminded_at IS NULL
          AND s.departure_date = CURRENT_DATE + 1`);
    for (const b of rows) {
      const time = String(b.departure_time).slice(0, 5);
      const seats = Array.isArray(b.seat_numbers) ? b.seat_numbers.join(', ') : '-';
      const text =
        `🚌 Pengingat keberangkatan besok!\n` +
        `Halo ${b.name || 'kak'}, tiket ${b.code}: ${b.origin} → ${b.destination}, ` +
        `besok ${b.departure_date} pukul ${time} WIB, kursi ${seats}.\n` +
        `Mohon tiba 30 menit sebelum berangkat ya. Selamat jalan! 🙏`;
      try {
        await _sendFn(b.session, b.wa_id, text);
        await query('UPDATE bookings SET reminded_at=now() WHERE id=$1', [b.id]);
      } catch (e) {
        console.error(`[lifecycle] gagal kirim pengingat ${b.code}:`, e.message);
      }
    }
    if (rows.length) console.log(`[lifecycle] kirim ${rows.length} pengingat keberangkatan H-1.`);
  } catch (e) {
    console.error('[lifecycle] remindDepartures error:', e.message);
  }
}

// ---- Housekeeping jarang (tiap menit): bayar kadaluarsa, presence basi, pengingat, broadcast ----
let _lastReminderDay = null;
let _backfillFails = 0;   // berapa siklus berturut backfill gagal (untuk backoff)
let _backfillSkip = 0;    // sisa siklus yang harus dilewati sebelum coba lagi
async function housekeeping() {
  try { await expireOverdue(); } catch (e) { console.error('[lifecycle] expireOverdue:', e.message); }
  try { await reapStalePresence(); } catch (e) { console.error('[lifecycle] reapPresence:', e.message); }
  try { await tickBroadcast(); } catch (e) { console.error('[lifecycle] broadcast:', e.message); }

  // Aktifkan broadcast terjadwal yang waktunya tiba.
  try { await activateDueBroadcasts(); } catch (e) { console.error('[lifecycle] broadcast jadwal:', e.message); }

  // Kejar skor sentimen pesan lama/historis yang belum dinilai (sedikit demi sedikit,
  // agar panel "Pembacaan Mood" menghitung SELURUH pesan, bukan hanya yang dinilai live).
  // BACKOFF: bila satu batch gagal total (scored=0 padahal masih ada sisa), kemungkinan
  // besar LLM sedang kena rate limit (429). Jeda beberapa siklus sebelum mencoba lagi
  // agar tidak terus-menerus menembak API dan memperparah 429 (lihat log lama).
  try {
    if (_backfillSkip > 0) {
      _backfillSkip--;
    } else {
      const batchSize = Number(process.env.SENTIMENT_BATCH || 15);
      const { scored, remaining } = await backfillSentimentBatch({ batchSize });
      if (scored > 0) {
        console.log(`[lifecycle] backfill sentimen: +${scored} dinilai, sisa ${remaining}.`);
        _backfillFails = 0;
      } else if (remaining > 0) {
        // Tidak ada yang berhasil padahal masih ada sisa -> mundur (maks ~10 menit).
        _backfillFails = Math.min(_backfillFails + 1, 10);
        _backfillSkip = _backfillFails;
        console.warn(`[lifecycle] backfill sentimen ditunda ${_backfillSkip} siklus (kemungkinan rate limit).`);
      }
    }
  } catch (e) { console.error('[lifecycle] backfill sentimen:', e.message); }

  // Pengingat H-1 dijalankan sekali per hari, pada/Setelah jam yang dikonfigurasi (default 09:00 lokal).
  try {
    const bh = await getSetting('business_hours', {});
    const tz = bh.tz || process.env.TZ || 'Asia/Jakarta';
    const sendHour = Number(process.env.REMINDER_HOUR || 9);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
    }).formatToParts(new Date());
    const today = `${parts.find(p => p.type === 'year').value}-${parts.find(p => p.type === 'month').value}-${parts.find(p => p.type === 'day').value}`;
    const hour = Number(parts.find(p => p.type === 'hour').value);
    if (hour >= sendHour && _lastReminderDay !== today) {
      _lastReminderDay = today;
      await remindDepartures();
    }
  } catch (e) {
    console.error('[lifecycle] reminder schedule:', e.message);
  }
}

export function startLifecycle(io, sendFn) {
  _io = io;
  _sendFn = sendFn;
  if (_timer) clearInterval(_timer);
  _timer = setInterval(tick, TICK_SEC * 1000);
  // housekeeping tiap 60 detik (terpisah dari pemindaian idle)
  setInterval(housekeeping, 60 * 1000);
  // jalankan housekeeping sekali di awal (mis. lanjutkan broadcast yang 'running')
  housekeeping();
  console.log(
    `[lifecycle] aktif — nudge @${FOLLOWUP_AFTER_MIN}m, tutup @${CLOSE_AFTER_MIN}m, ` +
    `maks ${MAX_FOLLOWUPS} follow-up, pindai tiap ${TICK_SEC}s; housekeeping tiap 60s.`
  );
}

export const lifecycleConfig = { FOLLOWUP_AFTER_MIN, CLOSE_AFTER_MIN, MAX_FOLLOWUPS };
