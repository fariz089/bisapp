import express from 'express';
import cors from 'cors';
import http from 'http';
import { Server } from 'socket.io';
import bcrypt from 'bcryptjs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

import { initDb, query } from './db/index.js';
import { signToken, authMiddleware, webhookAuth, verifyToken } from './services/auth.js';
import { sendMessage, getQr } from './services/wagate.js';
import { handleIncoming, sendAsAgent, getHistory } from './services/conversation.js';
import { evaluateAgent } from './services/llm.js';
import { startLifecycle, lifecycleConfig } from './services/lifecycle.js';
import {
  searchSchedules, bookedSeats, createAkapBooking,
  searchCharters, createCharterBooking, listBookings, updateBookingStatus,
  getBooking, computeRefund, rescheduleAkapBooking, cancelBooking, bookingChanges,
} from './services/tickets.js';
import {
  createPaymentForBooking, listPayments, getPaymentByRef,
  markPendingVerify, confirmPaid, paymentInstructionText,
} from './services/payments.js';
import { getAllSettings, getSetting, setSetting } from './services/settings.js';
import { conversationImpression } from './services/llm.js';
import { setAgentOnline, heartbeat } from './services/escalation.js';
import { initBroadcast, tickBroadcast } from './services/broadcast.js';
import { backfillForConversation, backfillSentimentBatch, pendingSentimentCount } from './services/sentiment.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
// strict:false agar body JSON primitif (true/false/angka/string) juga diterima,
// bukan hanya object/array. Mencegah crash saat menyimpan setting bernilai boolean.
app.use(express.json({ limit: '5mb', strict: false }));
// Tangani body JSON yang rusak agar mengembalikan 400 rapi, bukan error tak tertangani.
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Body JSON tidak valid' });
  }
  next(err);
});
app.use(express.static(path.join(__dirname, '..', 'public')));
// Media WhatsApp (gambar, dokumen) — folder bersama dengan WA service
const MEDIA_DIR = process.env.MEDIA_DIR || '/app/media';
app.use('/media', express.static(MEDIA_DIR));

const sendFn = (session, waId, text) => sendMessage(session, waId, text);

// ---------- AUTH ----------
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const { rows } = await query('SELECT * FROM agents WHERE email=$1 AND active=true', [email]);
  const agent = rows[0];
  if (!agent || !(await bcrypt.compare(password, agent.password)))
    return res.status(401).json({ error: 'Email atau password salah' });
  res.json({ token: signToken(agent), agent: { id: agent.id, name: agent.name, role: agent.role } });
});

// ---------- WEBHOOK dari WA service (pesan masuk) ----------
app.post('/api/webhook/incoming', webhookAuth, async (req, res) => {
  res.json({ ok: true }); // balas cepat
  try {
    await handleIncoming(req.body, io, sendFn);
  } catch (e) {
    console.error('[webhook] error:', e.message);
  }
});

// Webhook update status koneksi WA
app.post('/api/webhook/status', webhookAuth, async (req, res) => {
  const { session, status, phone } = req.body;
  await query('UPDATE wa_accounts SET status=$1, phone=COALESCE($2,phone) WHERE session=$3',
    [status, phone || null, session]);
  io.emit('wa:status', { session, status, phone });
  res.json({ ok: true });
});

// ---------- AKUN WA & QR ----------
app.get('/api/accounts', authMiddleware, async (req, res) => {
  const { rows } = await query('SELECT id, session, label, phone, status FROM wa_accounts ORDER BY id');
  res.json(rows);
});

app.get('/api/accounts/:session/qr', authMiddleware, async (req, res) => {
  try { res.json(await getQr(req.params.session)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- PERCAKAPAN ----------
app.get('/api/conversations', authMiddleware, async (req, res) => {
  const { accountId, mode, status, tag } = req.query;
  const cond = [], params = [];
  if (accountId) { params.push(accountId); cond.push(`c.account_id=$${params.length}`); }
  if (mode) { params.push(mode); cond.push(`c.mode=$${params.length}`); }
  if (status) { params.push(status); cond.push(`c.status=$${params.length}`); }
  if (tag) { params.push(tag); cond.push(`$${params.length} = ANY(c.tags)`); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const { rows } = await query(
    `SELECT c.*, cu.name AS customer_name, cu.phone, cu.wa_id, cu.behavior_tag, cu.behavior_note,
            cu.avg_sentiment, a.label AS account_label, ag.name AS agent_name
       FROM conversations c
       JOIN customers cu ON cu.id=c.customer_id
       JOIN wa_accounts a ON a.id=c.account_id
       LEFT JOIN agents ag ON ag.id=c.assigned_agent
       ${where}
      ORDER BY c.last_message_at DESC LIMIT 100`, params);
  res.json(rows);
});

app.get('/api/conversations/:id/messages', authMiddleware, async (req, res) => {
  const { rows } = await query(
    `SELECT m.*, ag.name AS agent_name FROM messages m
       LEFT JOIN agents ag ON ag.id=m.agent_id
      WHERE m.conversation_id=$1
      ORDER BY COALESCE(m.wa_timestamp, m.created_at) ASC, m.id ASC`, [req.params.id]);
  res.json(rows);
});

// Ambil alih percakapan (AI -> manusia)
app.post('/api/conversations/:id/take', authMiddleware, async (req, res) => {
  await query(`UPDATE conversations SET mode='human', status='open', assigned_agent=$1 WHERE id=$2`,
    [req.agent.id, req.params.id]);
  io.emit('conversation:update', { conversationId: +req.params.id });
  res.json({ ok: true });
});

// Kembalikan ke AI
app.post('/api/conversations/:id/release', authMiddleware, async (req, res) => {
  await query(`UPDATE conversations SET mode='ai', assigned_agent=NULL WHERE id=$1`, [req.params.id]);
  io.emit('conversation:update', { conversationId: +req.params.id });
  res.json({ ok: true });
});

// Selesaikan + evaluasi karyawan otomatis (AI)
app.post('/api/conversations/:id/resolve', authMiddleware, async (req, res) => {
  const id = +req.params.id;
  await query(`UPDATE conversations SET status='resolved', resolved_at=now(), close_reason='agent' WHERE id=$1`, [id]);
  res.json({ ok: true });
  // Evaluasi + CSAT di belakang
  try {
    const { rows } = await query(
      `SELECT c.assigned_agent, a.session, cu.wa_id
         FROM conversations c
         JOIN wa_accounts a ON a.id=c.account_id
         JOIN customers cu ON cu.id=c.customer_id WHERE c.id=$1`, [id]);
    const row = rows[0];
    const agentId = row?.assigned_agent;
    if (agentId) {
      const history = await getHistory(id, 40);
      const ev = await evaluateAgent(history);
      await query(
        `INSERT INTO agent_evaluations
          (conversation_id, agent_id, score_politeness, score_clarity, score_helpfulness, score_speed, summary)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, agentId, ev.politeness, ev.clarity, ev.helpfulness, ev.speed, ev.summary]);

      // Minta rating CSAT (sesi yang ditangani agen)
      const csat = await getSetting('csat', {});
      if (csat.enabled !== false && row?.session && row?.wa_id) {
        const token = randomUUID().slice(0, 12);
        await query(`UPDATE conversations SET csat_token=$2 WHERE id=$1`, [id, token]);
        const link = PUBLIC_URL ? `${PUBLIC_URL.replace(/\/$/, '')}/rate/${token}` : '';
        const ask = (csat.ask_message || 'Boleh beri penilaian layanan kami (1-5)? ') + (link || '');
        await sendMessage(row.session, row.wa_id, ask.trim()).catch(() => {});
        const m = await query(
          `INSERT INTO messages (conversation_id, account_id, direction, sender_type, body)
           SELECT $1, account_id, 'out','ai',$2 FROM conversations WHERE id=$1 RETURNING *`,
          [id, ask.trim()]).then(x => x.rows[0]).catch(() => null);
        if (m) io.emit('message:new', { conversationId: id, message: m });
      }
    }
  } catch (e) { console.error('[eval] gagal:', e.message); }
});

// Tag/label percakapan (tambah / hapus)
app.post('/api/conversations/:id/tags', authMiddleware, async (req, res) => {
  const id = +req.params.id;
  const tag = String(req.body.tag || '').trim().toLowerCase().replace(/\s+/g, '_').slice(0, 30);
  if (!tag) return res.status(400).json({ error: 'tag wajib' });
  const { rows } = await query(
    `UPDATE conversations
        SET tags = (SELECT ARRAY(SELECT DISTINCT unnest(COALESCE(tags,'{}') || $2::text)))
      WHERE id=$1 RETURNING tags`, [id, tag]);
  io.emit('conversation:update', { conversationId: id });
  res.json({ tags: rows[0]?.tags || [] });
});
app.delete('/api/conversations/:id/tags/:tag', authMiddleware, async (req, res) => {
  const id = +req.params.id;
  const tag = String(req.params.tag || '').toLowerCase();
  const { rows } = await query(
    `UPDATE conversations SET tags = array_remove(COALESCE(tags,'{}'), $2) WHERE id=$1 RETURNING tags`,
    [id, tag]);
  io.emit('conversation:update', { conversationId: id });
  res.json({ tags: rows[0]?.tags || [] });
});

// Kirim pesan sebagai karyawan
app.post('/api/conversations/:id/send', authMiddleware, async (req, res) => {
  try {
    const msg = await sendAsAgent(
      { conversationId: +req.params.id, agentId: req.agent.id, text: req.body.text }, io, sendFn);
    res.json(msg);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- KPI ----------
app.get('/api/kpi', authMiddleware, async (req, res) => {
  // Ringkasan per karyawan.
  // Catatan: evaluasi dirata-rata di SUBQUERY terpisah agar tidak terjadi
  // perkalian baris (double-count) saat satu agent punya banyak evaluasi.
  const { rows } = await query(`
    SELECT ag.id, ag.name,
      COUNT(DISTINCT c.id) FILTER (WHERE c.assigned_agent=ag.id) AS handled,
      COUNT(DISTINCT c.id) FILTER (WHERE c.assigned_agent=ag.id AND c.status='resolved') AS resolved,
      ROUND(AVG(c.first_reply_sec) FILTER (WHERE c.assigned_agent=ag.id))::int AS avg_first_reply_sec,
      ev.avg_quality
    FROM agents ag
    LEFT JOIN conversations c ON c.assigned_agent=ag.id
    LEFT JOIN (
      SELECT agent_id,
             ROUND(AVG((score_politeness+score_clarity+score_helpfulness+score_speed)/4.0),2) AS avg_quality
        FROM agent_evaluations GROUP BY agent_id
    ) ev ON ev.agent_id=ag.id
    WHERE ag.role='agent'
    GROUP BY ag.id, ag.name, ev.avg_quality
    ORDER BY handled DESC NULLS LAST`);
  res.json(rows);
});

// ---------- INSIGHT: ringkasan sentimen & perilaku (dashboard 'Insight') ----------
app.get('/api/insights/overview', authMiddleware, async (req, res) => {
  try {
    // Sebaran sentimen pelanggan berdasarkan avg_sentiment tersimpan
    const sentiment = (await query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE avg_sentiment >=  0.1)::int AS positif,
        COUNT(*) FILTER (WHERE avg_sentiment >  -0.1 AND avg_sentiment < 0.1)::int AS netral,
        COUNT(*) FILTER (WHERE avg_sentiment <= -0.1)::int AS negatif,
        COUNT(*) FILTER (WHERE avg_sentiment IS NULL)::int AS belum_dinilai,
        ROUND(AVG(avg_sentiment)::numeric,3) AS rata_rata
      FROM customers`)).rows[0];

    // Arketipe perilaku (jumlah per tag)
    const behavior = (await query(`
      SELECT COALESCE(behavior_tag,'netral') AS tag, COUNT(*)::int AS n
        FROM customers GROUP BY COALESCE(behavior_tag,'netral') ORDER BY n DESC`)).rows;

    // Pelanggan yang butuh perhatian (negatif / mudah marah)
    const attention = (await query(`
      SELECT name, phone, wa_id, behavior_tag, behavior_note, avg_sentiment
        FROM customers
       WHERE avg_sentiment <= -0.1 OR behavior_tag='mudah_marah'
       ORDER BY avg_sentiment ASC NULLS LAST LIMIT 10`)).rows;

    // Corong booking + nilai per status
    const funnel = (await query(`
      SELECT status, COUNT(*)::int AS n, COALESCE(SUM(amount),0)::numeric AS nilai
        FROM bookings GROUP BY status`)).rows;

    // Tren 14 hari: volume pesan customer + rata-rata mood harian
    const trend = (await query(`
      WITH days AS (
        SELECT generate_series(CURRENT_DATE-13, CURRENT_DATE, '1 day')::date AS hari
      )
      SELECT to_char(d.hari,'YYYY-MM-DD') AS hari,
             COUNT(m.id) FILTER (WHERE m.sender_type='customer')::int AS pesan,
             ROUND(AVG(m.sentiment) FILTER (WHERE m.sender_type='customer'),3) AS mood
        FROM days d
        LEFT JOIN messages m ON COALESCE(m.wa_timestamp, m.created_at)::date = d.hari
       GROUP BY d.hari ORDER BY d.hari`)).rows;

    // Rute terlaris (AKAP) berdasarkan jumlah booking
    const routes = (await query(`
      SELECT r.origin, r.destination, COUNT(b.id)::int AS bookings, COALESCE(SUM(b.amount),0)::numeric AS nilai
        FROM bookings b JOIN schedules s ON s.id=b.schedule_id JOIN routes r ON r.id=s.route_id
       WHERE b.service_type='akap'
       GROUP BY r.origin, r.destination ORDER BY bookings DESC LIMIT 6`)).rows;

    res.json({ sentiment, behavior, attention, funnel, trend, routes });
  } catch (e) {
    console.error('[insights] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ---------- Backfill sentimen manual (admin) ----------
// Memicu penilaian sentimen untuk pesan customer lama/historis yang belum dinilai.
// Berguna sekali jalan setelah sinkronisasi riwayat besar. Aman dipanggil berulang.
app.get('/api/insights/backfill-sentiment/status', authMiddleware, async (req, res) => {
  try { res.json({ pending: await pendingSentimentCount() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/insights/backfill-sentiment', authMiddleware, async (req, res) => {
  if (req.agent.role !== 'admin') return res.status(403).json({ error: 'Hanya admin' });
  try {
    const batchSize = Math.min(200, Math.max(1, +req.body?.batchSize || 50));
    const result = await backfillSentimentBatch({ batchSize });
    res.json(result); // { scored, remaining }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Bersihkan nomor telepon palsu dari @lid (admin) ----------
// Versi lama menyimpan bagian depan wa_id sebagai phone, termasuk untuk id @lid
// (id internal WhatsApp) yang BUKAN nomor telepon — menghasilkan '+279...' dst.
// Endpoint ini meng-NULL-kan phone yang: (a) bukan 8–15 digit, ATAU (b) wa_id-nya
// bukan @c.us (artinya digit phone tak bisa dipercaya sebagai nomor asli).
// Tampilan lalu menunjukkan "Nomor tak diketahui" alih-alih nomor karangan.
app.post('/api/customers/clean-phones', authMiddleware, async (req, res) => {
  if (req.agent.role !== 'admin') return res.status(403).json({ error: 'Hanya admin' });
  try {
    const r = await query(
      `UPDATE customers SET phone=NULL
        WHERE phone IS NOT NULL
          AND (
            wa_id NOT LIKE '%@c.us'
            OR length(regexp_replace(phone, '[^0-9]', '', 'g')) NOT BETWEEN 8 AND 15
          )`);
    res.json({ ok: true, cleaned: r.rowCount,
      info: 'Nomor yang tidak valid / berasal dari @lid di-NULL-kan. Nomor asli akan terisi otomatis saat customer mengirim pesan lagi (bila ter-link).' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Versi lama menyimpan 0 ("netral") saat penilaian LLM GAGAL (mis. 429), sehingga
// data terkunci netral. Endpoint ini meng-NULL-kan kembali skor 0 pada pesan yang
// SEBENARNYA berisi teks, agar scheduler menilainya ulang dengan benar.
// Pesan tanpa teks (media) dibiarkan 0 (memang netral). Aman dipanggil sekali.
app.post('/api/insights/reset-neutral', authMiddleware, async (req, res) => {
  if (req.agent.role !== 'admin') return res.status(403).json({ error: 'Hanya admin' });
  try {
    const r = await query(
      `UPDATE messages SET sentiment=NULL
        WHERE sender_type='customer' AND sentiment=0
          AND body IS NOT NULL AND length(trim(body)) > 0`);
    res.json({ ok: true, reset: r.rowCount, info: 'Sentimen 0 berteks di-NULL-kan; scheduler akan menilai ulang.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- INSIGHT per percakapan (panel mood di samping chat) ----------
// Cache kesan kualitatif agar tidak memanggil LLM tiap refresh panel.
// Regenerasi hanya bila jumlah pesan customer bertambah.
const _impressionCache = new Map(); // convId -> { count, data }

app.get('/api/conversations/:id/insight', authMiddleware, async (req, res) => {
  try {
    const id = +req.params.id;

    // Pastikan SELURUH pesan customer di percakapan ini sudah dinilai sentimennya
    // sebelum menghitung mood — agar tidak hanya "4 pesan" (yang dinilai live) yang masuk.
    // Dibatasi agar tidak memblokir terlalu lama; sisanya dikejar scheduler.
    await backfillForConversation(id, { max: 60 }).catch(() => {});

    const { rows } = await query(
      `SELECT sentiment, created_at FROM messages
        WHERE conversation_id=$1 AND sender_type='customer' AND sentiment IS NOT NULL
        ORDER BY COALESCE(wa_timestamp, created_at) ASC, id ASC`, [id]);
    const series = rows.map(r => Number(r.sentiment));
    const count = series.length;
    const avg = count ? Math.round((series.reduce((a, b) => a + b, 0) / count) * 1000) / 1000 : null;

    // Tren: bandingkan rata-rata paruh awal vs paruh akhir
    let trend = 'stabil';
    if (count >= 4) {
      const half = Math.floor(count / 2);
      const early = series.slice(0, half).reduce((a, b) => a + b, 0) / half;
      const late = series.slice(half).reduce((a, b) => a + b, 0) / (count - half);
      if (late - early > 0.15) trend = 'membaik';
      else if (early - late > 0.15) trend = 'memburuk';
    }

    // Kesan kualitatif (cache by jumlah pesan customer). Hanya bila ada cukup konteks.
    let impression = null;
    const totalCust = (await query(
      `SELECT COUNT(*)::int AS n FROM messages WHERE conversation_id=$1 AND sender_type='customer'`, [id]
    )).rows[0].n;
    if (totalCust >= 2) {
      const cached = _impressionCache.get(id);
      if (cached && cached.count === totalCust) {
        impression = cached.data;
      } else {
        const history = await getHistory(id, 40);
        impression = await conversationImpression(history).catch(() => null);
        if (impression) _impressionCache.set(id, { count: totalCust, data: impression });
      }
    }

    res.json({ count, avg, trend, series, impression });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Nilai ULANG sentimen + kesan untuk satu percakapan (mis. setelah perbaikan model).
app.post('/api/conversations/:id/reanalyze', authMiddleware, async (req, res) => {
  try {
    const id = +req.params.id;
    const scored = await backfillForConversation(id, { max: 200, force: true });
    _impressionCache.delete(id); // paksa regenerasi kesan
    res.json({ ok: true, rescored: scored });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- BALASAN CEPAT (quick replies) ----------
app.get('/api/quick-replies', authMiddleware, async (req, res) => {
  const { rows } = await query('SELECT * FROM quick_replies ORDER BY id DESC');
  res.json(rows);
});
app.post('/api/quick-replies', authMiddleware, async (req, res) => {
  const { title, body } = req.body;
  if (!title || !body) return res.status(400).json({ error: 'Judul & isi wajib' });
  const { rows } = await query(
    'INSERT INTO quick_replies (title, body, created_by) VALUES ($1,$2,$3) RETURNING *',
    [title, body, req.agent.id]);
  res.json(rows[0]);
});
app.delete('/api/quick-replies/:id', authMiddleware, async (req, res) => {
  await query('DELETE FROM quick_replies WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ---------- DASHBOARD OPERASIONAL ----------
// Ringkasan kesehatan operasi hari ini + antrian + siklus sesi.
app.get('/api/dashboard', authMiddleware, async (req, res) => {
  try {
    // Kartu ringkas
    const live = (await query(`
      SELECT
        COUNT(*) FILTER (WHERE status<>'resolved')::int AS aktif,
        COUNT(*) FILTER (WHERE status='pending' OR mode='human')::int AS perlu_agen,
        COUNT(*) FILTER (WHERE mode='ai' AND status<>'resolved')::int AS ditangani_ai,
        COUNT(*) FILTER (WHERE status='resolved' AND resolved_at::date=CURRENT_DATE)::int AS selesai_hari_ini
      FROM conversations`)).rows[0];

    // Bagaimana sesi ditutup (hari ini) — efektivitas AI vs eskalasi vs timeout
    const closures = (await query(`
      SELECT COALESCE(close_reason,'lainnya') AS alasan, COUNT(*)::int AS n
        FROM conversations
       WHERE status='resolved' AND resolved_at::date=CURRENT_DATE
       GROUP BY COALESCE(close_reason,'lainnya')`)).rows;

    // Follow-up otomatis hari ini
    const followups = (await query(`
      SELECT COALESCE(SUM(followups_sent),0)::int AS total_nudge,
             COUNT(*) FILTER (WHERE followups_sent>0)::int AS percakapan_dinudge
        FROM conversations WHERE last_message_at::date=CURRENT_DATE`)).rows[0];

    // Pendapatan & booking hari ini
    const sales = (await query(`
      SELECT COUNT(*)::int AS booking_baru,
             COALESCE(SUM(amount) FILTER (WHERE status='paid'),0)::numeric AS lunas_nilai,
             COALESCE(SUM(amount) FILTER (WHERE status IN ('pending','confirmed')),0)::numeric AS pipeline_nilai
        FROM bookings WHERE created_at::date=CURRENT_DATE`)).rows[0];

    // Antrian: percakapan yang menunggu agen, terlama dulu
    const queue = (await query(`
      SELECT c.id, cu.name, cu.phone, c.mode, c.status, c.last_sender,
             a.label AS channel,
             EXTRACT(EPOCH FROM (now()-c.last_message_at))::int AS idle_sec
        FROM conversations c
        JOIN customers cu ON cu.id=c.customer_id
        JOIN wa_accounts a ON a.id=c.account_id
       WHERE c.status<>'resolved' AND (c.status='pending' OR c.mode='human')
       ORDER BY c.last_message_at ASC LIMIT 12`)).rows;

    // Volume 7 hari (masuk vs keluar)
    const volume = (await query(`
      WITH days AS (SELECT generate_series(CURRENT_DATE-6, CURRENT_DATE,'1 day')::date AS hari)
      SELECT to_char(d.hari,'YYYY-MM-DD') AS hari,
             COUNT(m.id) FILTER (WHERE m.direction='in')::int AS masuk,
             COUNT(m.id) FILTER (WHERE m.direction='out')::int AS keluar
        FROM days d LEFT JOIN messages m ON COALESCE(m.wa_timestamp, m.created_at)::date=d.hari
       GROUP BY d.hari ORDER BY d.hari`)).rows;

    res.json({ live, closures, followups, sales, queue, volume, config: lifecycleConfig });
  } catch (e) {
    console.error('[dashboard] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ---------- KNOWLEDGE BASE ----------
app.get('/api/knowledge', authMiddleware, async (req, res) => {
  const { rows } = await query('SELECT * FROM knowledge ORDER BY id DESC');
  res.json(rows);
});
app.post('/api/knowledge', authMiddleware, async (req, res) => {
  const { category, question, answer } = req.body;
  const { rows } = await query(
    'INSERT INTO knowledge (category, question, answer) VALUES ($1,$2,$3) RETURNING *',
    [category, question, answer]);
  res.json(rows[0]);
});
app.delete('/api/knowledge/:id', authMiddleware, async (req, res) => {
  await query('DELETE FROM knowledge WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ---------- AGENTS (admin) ----------
app.get('/api/agents', authMiddleware, async (req, res) => {
  const { rows } = await query('SELECT id, name, email, role, active FROM agents ORDER BY id');
  res.json(rows);
});
app.post('/api/agents', authMiddleware, async (req, res) => {
  if (req.agent.role !== 'admin') return res.status(403).json({ error: 'khusus admin' });
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: 'Nama, email, dan password wajib diisi' });
  if (String(password).length < 6)
    return res.status(400).json({ error: 'Password minimal 6 karakter' });
  const hash = await bcrypt.hash(password, 10);
  try {
    const { rows } = await query(
      'INSERT INTO agents (name,email,password,role) VALUES ($1,$2,$3,$4) RETURNING id,name,email,role',
      [name, email, hash, 'agent']);
    res.json(rows[0]);
  } catch (e) { res.status(400).json({ error: 'Email sudah dipakai' }); }
});

// Buat/cari customer (dipakai modul booking manual)
app.post('/api/customers', authMiddleware, async (req, res) => {
  const phone = (req.body.phone || '').replace(/\D/g, '');
  if (!phone) return res.status(400).json({ error: 'phone wajib' });
  const waId = phone + '@c.us';
  let { rows } = await query('SELECT id FROM customers WHERE wa_id=$1 OR phone=$2', [waId, phone]);
  if (rows.length) return res.json({ id: rows[0].id });
  ({ rows } = await query(
    'INSERT INTO customers (wa_id, phone, name) VALUES ($1,$2,$3) RETURNING id',
    [waId, phone, req.body.name || null]));
  res.json({ id: rows[0].id });
});

// ==================== MODUL TIKET ====================

// --- Master data (rute, bus, jadwal, paket) ---
app.get('/api/routes', authMiddleware, async (req, res) => {
  const { rows } = await query('SELECT * FROM routes ORDER BY origin, destination');
  res.json(rows);
});
app.post('/api/routes', authMiddleware, async (req, res) => {
  const { origin, destination, distance_km, base_price } = req.body;
  const { rows } = await query(
    'INSERT INTO routes (origin,destination,distance_km,base_price) VALUES ($1,$2,$3,$4) RETURNING *',
    [origin, destination, distance_km || null, base_price]);
  res.json(rows[0]);
});

app.get('/api/buses', authMiddleware, async (req, res) => {
  const { rows } = await query('SELECT * FROM buses ORDER BY code');
  res.json(rows);
});
app.post('/api/buses', authMiddleware, async (req, res) => {
  const { code, name, bus_class, total_seats, usage_type } = req.body;
  try {
    const { rows } = await query(
      'INSERT INTO buses (code,name,bus_class,total_seats,usage_type) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [code, name || null, bus_class || null, total_seats || 40, usage_type || 'both']);
    res.json(rows[0]);
  } catch { res.status(400).json({ error: 'Kode bus sudah dipakai' }); }
});

app.get('/api/schedules', authMiddleware, async (req, res) => {
  const { origin, destination, date } = req.query;
  res.json(await searchSchedules({ origin, destination, date }));
});
app.post('/api/schedules', authMiddleware, async (req, res) => {
  const { route_id, bus_id, departure_date, departure_time, price } = req.body;
  try {
    const { rows } = await query(
      `INSERT INTO schedules (route_id,bus_id,departure_date,departure_time,price)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [route_id, bus_id, departure_date, departure_time, price]);
    res.json(rows[0]);
  } catch (e) { res.status(400).json({ error: 'Jadwal bentrok / tidak valid' }); }
});

// Kursi terisi untuk satu jadwal (untuk peta kursi)
app.get('/api/schedules/:id/seats', authMiddleware, async (req, res) => {
  const taken = await bookedSeats(+req.params.id);
  const { rows } = await query(
    `SELECT b.total_seats FROM schedules s JOIN buses b ON b.id=s.bus_id WHERE s.id=$1`, [req.params.id]);
  res.json({ total: rows[0]?.total_seats || 0, taken });
});

app.get('/api/charters', authMiddleware, async (req, res) => {
  res.json(await searchCharters({ paxMin: req.query.pax ? +req.query.pax : undefined }));
});
app.post('/api/charters', authMiddleware, async (req, res) => {
  const { name, bus_class, price_per_day, capacity, includes } = req.body;
  const { rows } = await query(
    `INSERT INTO charter_packages (name,bus_class,price_per_day,capacity,includes)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [name, bus_class || null, price_per_day, capacity || null, includes || null]);
  res.json(rows[0]);
});

// --- Booking ---
app.get('/api/bookings', authMiddleware, async (req, res) => {
  res.json(await listBookings({ customerId: req.query.customerId, status: req.query.status }));
});

// Booking AKAP (kursi)
app.post('/api/bookings/akap', authMiddleware, async (req, res) => {
  const { scheduleId, seats, customerId, conversationId, pax } = req.body;
  if (!scheduleId || !Array.isArray(seats) || !seats.length || !customerId)
    return res.status(400).json({ error: 'scheduleId, seats[], customerId wajib' });
  try {
    const b = await createAkapBooking({
      scheduleId, seats, customerId, conversationId, agentId: req.agent.id, pax });
    res.json(b);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Booking Pariwisata (carter)
app.post('/api/bookings/pariwisata', authMiddleware, async (req, res) => {
  const { charterId, customerId, conversationId, startDate, days, destination, pax } = req.body;
  if (!charterId || !customerId) return res.status(400).json({ error: 'charterId, customerId wajib' });
  try {
    const b = await createCharterBooking({
      charterId, customerId, conversationId, agentId: req.agent.id, startDate, days, destination, pax });
    res.json(b);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/bookings/:id/status', authMiddleware, async (req, res) => {
  await updateBookingStatus(+req.params.id, req.body.status);
  io.emit('booking:update', { id: +req.params.id });
  res.json({ ok: true });
});

// Detail booking + riwayat perubahan
app.get('/api/bookings/:id/detail', authMiddleware, async (req, res) => {
  try {
    const b = await getBooking(+req.params.id);
    if (!b) return res.status(404).json({ error: 'Booking tidak ditemukan' });
    const changes = await bookingChanges(b.id);
    res.json({ booking: b, changes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Estimasi refund pembatalan (tanpa eksekusi) — untuk ditampilkan sebelum konfirmasi
app.get('/api/bookings/:id/refund-quote', authMiddleware, async (req, res) => {
  try {
    const b = await getBooking(+req.params.id);
    if (!b) return res.status(404).json({ error: 'Booking tidak ditemukan' });
    const policy = await getSetting('refund_policy', {});
    if (b.service_type === 'pariwisata') {
      return res.json({ service_type: 'pariwisata', manual: true, note: policy.pariwisata_note || 'Pembatalan pariwisata via staf.' });
    }
    const q = computeRefund(b, policy);
    res.json({ service_type: 'akap', amount_paid: Number(b.amount) || 0, ...q });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Reschedule AKAP ke jadwal baru
app.post('/api/bookings/:id/reschedule', authMiddleware, async (req, res) => {
  const id = +req.params.id;
  const { newScheduleId, notify } = req.body;
  if (!newScheduleId) return res.status(400).json({ error: 'newScheduleId wajib' });
  try {
    const policy = await getSetting('refund_policy', {});
    const fee = Number(policy.reschedule_fee || 0);
    const out = await rescheduleAkapBooking({
      bookingId: id, newScheduleId: +newScheduleId, fee,
      actor: 'agent', agentId: req.agent.id, reason: req.body.reason || null,
    });
    io.emit('booking:update', { id });

    // Beri tahu customer via WA bila diminta
    if (notify) {
      const info = await getBooking(id);
      const r = (await query(
        `SELECT a.session, cu.wa_id FROM bookings b
           JOIN conversations c ON c.id=b.conversation_id
           JOIN wa_accounts a ON a.id=c.account_id
           JOIN customers cu ON cu.id=b.customer_id WHERE b.id=$1`, [id])).rows[0];
      if (r?.session && r?.wa_id) {
        const time = String(info.departure_time).slice(0, 5);
        const txt = `✅ Jadwal tiket ${info.code} berhasil diubah ke ${info.origin} → ${info.destination}, ` +
          `${info.departure_date} ${time}, kursi ${out.newSeats.join(', ')}. ` +
          `Total terbaru Rp${Number(out.newAmount).toLocaleString('id-ID')}` +
          (fee ? ` (termasuk biaya admin Rp${fee.toLocaleString('id-ID')})` : '') + '. Terima kasih 🙏';
        await sendMessage(r.session, r.wa_id, txt).catch(() => {});
      }
    }
    res.json({ ok: true, ...out });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Batalkan booking + refund sesuai kebijakan
app.post('/api/bookings/:id/cancel', authMiddleware, async (req, res) => {
  const id = +req.params.id;
  const { notify } = req.body;
  try {
    const b = await getBooking(id);
    if (!b) return res.status(404).json({ error: 'Booking tidak ditemukan' });
    const policy = await getSetting('refund_policy', {});
    let refundAmount = 0, label = '-';
    if (b.service_type === 'akap') {
      const q = computeRefund(b, policy);
      refundAmount = q.refundAmount; label = q.tier;
    }
    // Admin boleh override nilai refund
    if (req.body.refundAmount != null) refundAmount = Math.max(0, +req.body.refundAmount);

    await cancelBooking({
      bookingId: id, refundAmount, fee: 0,
      actor: 'agent', agentId: req.agent.id, reason: req.body.reason || null,
    });
    io.emit('booking:update', { id });

    if (notify) {
      const r = (await query(
        `SELECT a.session, cu.wa_id FROM bookings b
           JOIN conversations c ON c.id=b.conversation_id
           JOIN wa_accounts a ON a.id=c.account_id
           JOIN customers cu ON cu.id=b.customer_id WHERE b.id=$1`, [id])).rows[0];
      if (r?.session && r?.wa_id) {
        const txt = `Booking ${b.code} telah dibatalkan. ` +
          (refundAmount > 0
            ? `Dana yang dikembalikan: Rp${refundAmount.toLocaleString('id-ID')} (kebijakan ${label}). Proses refund 1-3 hari kerja.`
            : `Sesuai kebijakan, tidak ada pengembalian dana untuk pembatalan ini.`) +
          ` Terima kasih 🙏`;
        await sendMessage(r.session, r.wa_id, txt).catch(() => {});
      }
    }
    res.json({ ok: true, refundAmount, tier: label });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ==================== PEMBAYARAN ====================
const PUBLIC_URL = process.env.PUBLIC_URL || '';

// Buat tagihan untuk sebuah booking (staf), kirim instruksi ke customer bila diminta
app.post('/api/bookings/:id/payment', authMiddleware, async (req, res) => {
  try {
    const payment = await createPaymentForBooking(+req.params.id, {
      method: req.body.method || 'qris', baseUrl: PUBLIC_URL,
    });
    let sent = false;
    if (req.body.send) {
      // kirim instruksi ke customer lewat WA
      const { rows } = await query(
        `SELECT a.session, cu.wa_id, b.conversation_id
           FROM bookings b
           LEFT JOIN conversations c ON c.id=b.conversation_id
           LEFT JOIN wa_accounts a ON a.id=c.account_id
           JOIN customers cu ON cu.id=b.customer_id
          WHERE b.id=$1`, [+req.params.id]);
      const r = rows[0];
      if (r?.session && r?.wa_id) {
        const instr = await paymentInstructionText(payment);
        await sendMessage(r.session, r.wa_id, instr).catch(() => {});
        if (r.conversation_id) {
          const m = await query(
            `INSERT INTO messages (conversation_id, account_id, direction, sender_type, body)
             SELECT $1, account_id, 'out','agent',$2 FROM conversations WHERE id=$1 RETURNING *`,
            [r.conversation_id, instr]).then(x => x.rows[0]).catch(() => null);
          if (m) io.emit('message:new', { conversationId: r.conversation_id, message: m });
        }
        sent = true;
      }
    }
    res.json({ payment, sent });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/payments', authMiddleware, async (req, res) => {
  res.json(await listPayments({ status: req.query.status }));
});

// Staf mengonfirmasi lunas
app.post('/api/payments/:id/confirm', authMiddleware, async (req, res) => {
  try {
    const r = await confirmPaid(+req.params.id);
    io.emit('booking:update', { id: r.bookingId });
    io.emit('payment:update', { id: +req.params.id, status: 'paid' });
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// --- Halaman pembayaran publik (dibuka customer dari link) — TANPA auth ---
app.get('/pay/:ref', async (req, res) => {
  const p = await getPaymentByRef(req.params.ref).catch(() => null);
  if (!p) return res.status(404).send('<h2>Tagihan tidak ditemukan</h2>');
  const info = await getSetting('payment_info', {});
  const rp = 'Rp' + Number(p.amount || 0).toLocaleString('id-ID');
  const paid = p.status === 'paid';
  const pending = p.status === 'pending_verify';
  res.set('Content-Type', 'text/html; charset=utf-8').send(`<!doctype html><html lang="id"><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Pembayaran ${p.reference}</title>
    <style>body{font-family:system-ui,Arial,sans-serif;background:#f5f6f8;margin:0;padding:24px;color:#1a1a1a}
    .card{max-width:420px;margin:24px auto;background:#fff;border-radius:16px;box-shadow:0 6px 24px rgba(0,0,0,.08);padding:24px}
    h1{font-size:20px;margin:0 0 4px}.muted{color:#777;font-size:13px}.amt{font-size:32px;font-weight:800;margin:14px 0;color:#2563eb}
    .qr{width:220px;height:220px;object-fit:contain;display:block;margin:14px auto;border:1px solid #eee;border-radius:12px}
    .bank{background:#f0f4ff;border-radius:10px;padding:12px;margin:12px 0;font-size:14px}
    .badge{display:inline-block;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:700}
    .ok{background:#dcfce7;color:#166534}.pend{background:#fef9c3;color:#854d0e}.un{background:#e0e7ff;color:#3730a3}
    button{width:100%;padding:13px;border:0;border-radius:10px;background:#2563eb;color:#fff;font-size:15px;font-weight:600;margin-top:14px;cursor:pointer}
    button:disabled{opacity:.5}</style></head><body>
    <div class="card">
      <h1>Tagihan ${p.reference}</h1>
      <div class="muted">Booking ${p.booking_code} · ${p.customer_name || ''}</div>
      <div class="amt">${rp}</div>
      <div>Status: <span class="badge ${paid?'ok':pending?'pend':'un'}">${paid?'LUNAS':pending?'MENUNGGU VERIFIKASI':'BELUM DIBAYAR'}</span></div>
      ${paid ? '<p>Terima kasih, pembayaran Anda sudah kami terima ✅</p>' : `
        ${info.qris_image_url ? `<img class="qr" src="${info.qris_image_url}" alt="QRIS"/>` : ''}
        ${info.bank_account ? `<div class="bank"><b>Transfer Bank</b><br>${info.bank_name} <b>${info.bank_account}</b><br>a.n. ${info.bank_holder}</div>` : ''}
        <p class="muted">${info.note || 'Setelah membayar, klik tombol di bawah lalu kirim bukti via WhatsApp.'}</p>
        <button id="btn" ${pending?'disabled':''} onclick="mark()">${pending?'Menunggu verifikasi staf…':'Saya sudah membayar'}</button>
      `}
    </div>
    <script>
      async function mark(){
        const b=document.getElementById('btn'); b.disabled=true; b.textContent='Memproses…';
        try{ const r=await fetch('/pay/${p.reference}/paid',{method:'POST'}); if(r.ok){ b.textContent='Menunggu verifikasi staf…'; } else { b.textContent='Gagal, coba lagi'; b.disabled=false; } }
        catch{ b.textContent='Gagal, coba lagi'; b.disabled=false; }
      }
    </script></body></html>`);
});

// Customer menandai sudah bayar (dari halaman publik) — TANPA auth
app.post('/pay/:ref/paid', async (req, res) => {
  const p = await markPendingVerify(req.params.ref).catch(() => null);
  if (!p) return res.status(400).json({ error: 'gagal / sudah diproses' });
  io.emit('payment:update', { reference: req.params.ref, status: 'pending_verify' });
  res.json({ ok: true });
});

// --- Halaman rating CSAT publik (dibuka customer dari link) — TANPA auth ---
app.get('/rate/:token', async (req, res) => {
  const { rows } = await query(
    `SELECT id, csat_score FROM conversations WHERE csat_token=$1`, [req.params.token]);
  const c = rows[0];
  if (!c) return res.status(404).send('<h2>Tautan penilaian tidak valid atau sudah dipakai.</h2>');
  const done = c.csat_score != null;
  res.set('Content-Type', 'text/html; charset=utf-8').send(`<!doctype html><html lang="id"><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Penilaian Layanan</title><style>
    body{font-family:system-ui,Segoe UI,Roboto,sans-serif;background:#f1f5f9;margin:0;padding:24px;color:#0f172a;display:flex;min-height:90vh;align-items:center;justify-content:center}
    .card{background:#fff;border-radius:18px;padding:28px;max-width:380px;width:100%;box-shadow:0 10px 40px rgba(0,0,0,.08);text-align:center}
    h1{font-size:19px;margin:0 0 6px}.muted{color:#64748b;font-size:14px;margin-bottom:18px}
    .stars{display:flex;gap:8px;justify-content:center;margin:18px 0}
    .star{font-size:38px;cursor:pointer;color:#cbd5e1;transition:.15s;line-height:1}
    .star:hover,.star.on{color:#f59e0b;transform:scale(1.08)}
    .ok{color:#16a34a;font-size:15px;margin-top:14px}
    </style></head><body><div class="card">
    ${done ? `<h1>Terima kasih! 🙏</h1><div class="muted">Anda sudah memberi nilai ${c.csat_score}/5.</div>`
      : `<h1>Bagaimana layanan kami?</h1><div class="muted">Ketuk bintang untuk menilai (1-5).</div>
        <div class="stars" id="stars">${[1,2,3,4,5].map(n=>`<span class="star" data-n="${n}">★</span>`).join('')}</div>
        <div id="msg"></div>`}
    </div><script>
      const stars=[...document.querySelectorAll('.star')];
      stars.forEach(s=>{
        s.onmouseenter=()=>{const n=+s.dataset.n;stars.forEach(x=>x.classList.toggle('on',+x.dataset.n<=n));};
        s.onclick=async()=>{const n=+s.dataset.n;
          try{const r=await fetch('/rate/${req.params.token}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({score:n})});
            if(r.ok){document.getElementById('stars').style.pointerEvents='none';document.getElementById('msg').innerHTML='<div class="ok">Terima kasih atas penilaian Anda! 🙏</div>';}
          }catch{document.getElementById('msg').innerHTML='<div class="ok">Gagal mengirim, coba lagi.</div>';}
        };
      });
      document.getElementById('stars')?.addEventListener('mouseleave',()=>stars.forEach(x=>x.classList.remove('on')));
    </script></body></html>`);
});
app.post('/rate/:token', async (req, res) => {
  const score = Math.max(1, Math.min(5, parseInt(req.body.score, 10) || 0));
  if (!score) return res.status(400).json({ error: 'score 1-5' });
  const { rows } = await query(
    `UPDATE conversations SET csat_score=$2, csat_at=now(), csat_token=NULL
      WHERE csat_token=$1 AND csat_score IS NULL RETURNING id`, [req.params.token, score]);
  if (!rows[0]) return res.status(400).json({ error: 'sudah dinilai / token tidak valid' });
  io.emit('csat:new', { conversationId: rows[0].id, score });
  res.json({ ok: true });
});

// ==================== BROADCAST ====================
// Buat broadcast + isi target (audience: 'all' | 'akap_buyers' | 'pariwisata_buyers' | 'negative')
// Mendukung variabel template {nama} dan penjadwalan (scheduledAt ISO, opsional).
app.post('/api/broadcasts', authMiddleware, async (req, res) => {
  const { session, title, body, audience, scheduledAt } = req.body;
  if (!session || !body) return res.status(400).json({ error: 'session & body wajib' });
  const max = Number(process.env.BROADCAST_MAX_PER_RUN || 500);

  let where = '1=1';
  if (audience === 'akap_buyers') where = `id IN (SELECT DISTINCT customer_id FROM bookings WHERE service_type='akap')`;
  else if (audience === 'pariwisata_buyers') where = `id IN (SELECT DISTINCT customer_id FROM bookings WHERE service_type='pariwisata')`;
  else if (audience === 'negative') where = `avg_sentiment <= -0.1`;

  // Validasi jadwal (harus di masa depan bila diisi)
  let schedAt = null;
  if (scheduledAt) {
    const d = new Date(scheduledAt);
    if (isNaN(d.getTime())) return res.status(400).json({ error: 'scheduledAt tidak valid' });
    schedAt = d.toISOString();
  }
  // Jika dijadwalkan, status awal 'scheduled'; jika tidak, 'draft' (dimulai manual).
  const initStatus = schedAt ? 'scheduled' : 'draft';

  const bc = (await query(
    `INSERT INTO broadcasts (session,title,body,status,created_by,scheduled_at)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [session, title || null, body, initStatus, req.agent.id, schedAt])).rows[0];

  const targets = (await query(
    `SELECT id, wa_id FROM customers WHERE ${where} AND wa_id IS NOT NULL LIMIT ${max}`)).rows;
  for (const t of targets) {
    await query(
      `INSERT INTO broadcast_targets (broadcast_id, customer_id, wa_id) VALUES ($1,$2,$3)`,
      [bc.id, t.id, t.wa_id]);
  }
  await query('UPDATE broadcasts SET total=$1 WHERE id=$2', [targets.length, bc.id]);
  res.json({ ...bc, total: targets.length });
});

app.get('/api/broadcasts', authMiddleware, async (req, res) => {
  const { rows } = await query(
    `SELECT b.*, ag.name AS by_name FROM broadcasts b LEFT JOIN agents ag ON ag.id=b.created_by
      ORDER BY b.id DESC LIMIT 50`);
  res.json(rows);
});

// Jalankan / jeda / batalkan broadcast
app.post('/api/broadcasts/:id/:action', authMiddleware, async (req, res) => {
  const { id, action } = req.params;
  const map = { start: 'running', pause: 'paused', cancel: 'cancelled' };
  const status = map[action];
  if (!status) return res.status(400).json({ error: 'aksi tidak dikenal' });
  await query('UPDATE broadcasts SET status=$1 WHERE id=$2', [status, id]);
  io.emit('broadcast:update', { id: +id, status });
  if (status === 'running') tickBroadcast(); // picu worker
  res.json({ ok: true, status });
});

// ==================== PENGATURAN ====================
app.get('/api/settings', authMiddleware, async (req, res) => {
  res.json(await getAllSettings());
});
app.put('/api/settings/:key', authMiddleware, async (req, res) => {
  if (req.agent.role !== 'admin') return res.status(403).json({ error: 'khusus admin' });
  const v = await setSetting(req.params.key, req.body);
  res.json({ ok: true, value: v });
});

// ==================== LAPORAN / EKSPOR CSV ====================
function toCsv(rows, headers) {
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v).replace(/"/g, '""');
    return /[",\n]/.test(s) ? `"${s}"` : s;
  };
  const head = headers.map(h => esc(h.label)).join(',');
  const body = rows.map(r => headers.map(h => esc(r[h.key])).join(',')).join('\n');
  return head + '\n' + body + '\n';
}

app.get('/api/reports/kpi.csv', authMiddleware, async (req, res) => {
  const { rows } = await query(`
    SELECT ag.name,
      COUNT(DISTINCT c.id) FILTER (WHERE c.assigned_agent=ag.id) AS handled,
      COUNT(DISTINCT c.id) FILTER (WHERE c.assigned_agent=ag.id AND c.status='resolved') AS resolved,
      ROUND(AVG(c.first_reply_sec) FILTER (WHERE c.assigned_agent=ag.id))::int AS avg_first_reply_sec,
      ev.avg_quality
    FROM agents ag
    LEFT JOIN conversations c ON c.assigned_agent=ag.id
    LEFT JOIN (SELECT agent_id, ROUND(AVG((score_politeness+score_clarity+score_helpfulness+score_speed)/4.0),2) AS avg_quality FROM agent_evaluations GROUP BY agent_id) ev ON ev.agent_id=ag.id
    WHERE ag.role='agent' GROUP BY ag.id, ag.name, ev.avg_quality ORDER BY handled DESC NULLS LAST`);
  const csv = toCsv(rows, [
    { key: 'name', label: 'Karyawan' }, { key: 'handled', label: 'Ditangani' },
    { key: 'resolved', label: 'Diselesaikan' }, { key: 'avg_first_reply_sec', label: 'Respons pertama (dtk)' },
    { key: 'avg_quality', label: 'Skor kualitas' },
  ]);
  res.set('Content-Type', 'text/csv; charset=utf-8')
     .set('Content-Disposition', 'attachment; filename="kpi.csv"').send(csv);
});

app.get('/api/reports/sales.csv', authMiddleware, async (req, res) => {
  const { rows } = await query(`
    SELECT b.code, b.service_type, b.status, b.amount, b.created_at,
           cu.name AS customer, cu.phone,
           COALESCE(r.origin||' → '||r.destination, cp.name) AS detail
      FROM bookings b
      JOIN customers cu ON cu.id=b.customer_id
      LEFT JOIN schedules s ON s.id=b.schedule_id
      LEFT JOIN routes r ON r.id=s.route_id
      LEFT JOIN charter_packages cp ON cp.id=b.charter_id
     ORDER BY b.created_at DESC LIMIT 5000`);
  const csv = toCsv(rows, [
    { key: 'code', label: 'Kode' }, { key: 'service_type', label: 'Layanan' },
    { key: 'detail', label: 'Detail' }, { key: 'customer', label: 'Customer' },
    { key: 'phone', label: 'Telepon' }, { key: 'amount', label: 'Nilai' },
    { key: 'status', label: 'Status' }, { key: 'created_at', label: 'Dibuat' },
  ]);
  res.set('Content-Type', 'text/csv; charset=utf-8')
     .set('Content-Disposition', 'attachment; filename="sales.csv"').send(csv);
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ==================== SOCKET (dashboard + presence agen) ====================
io.on('connection', (socket) => {
  // Klien mengirim token via auth saat connect untuk presence agen.
  const token = socket.handshake?.auth?.token;
  const payload = token ? verifyToken(token) : null;
  if (payload?.id) {
    socket.data.agentId = payload.id;
    setAgentOnline(payload.id, true).catch(() => {});
    io.emit('presence:update', { agentId: payload.id, online: true });
    // heartbeat berkala dari klien
    socket.on('agent:heartbeat', () => heartbeat(payload.id).catch(() => {}));
    socket.on('disconnect', () => {
      setAgentOnline(payload.id, false).catch(() => {});
      io.emit('presence:update', { agentId: payload.id, online: false });
    });
  }
});

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => server.listen(PORT, () => {
    console.log(`[backend] jalan di :${PORT}`);
    initBroadcast(io, sendFn);            // worker broadcast
    startLifecycle(io, sendFn);           // follow-up, auto-close, pengingat, housekeeping
  }))
  .catch(e => { console.error('Gagal init DB:', e); process.exit(1); });
