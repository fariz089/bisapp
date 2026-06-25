// =====================================================================
// Backfill sentimen: memberi skor pada pesan CUSTOMER yang belum dinilai.
//
// Latar belakang: pesan yang disinkronkan dari riwayat WhatsApp (historical)
// dan pesan lama sebelum fitur sentimen ada, tersimpan dengan sentiment = NULL.
// Akibatnya panel "Pembacaan Mood" hanya menghitung sedikit pesan (yang dinilai
// live), padahal percakapan panjang. Modul ini mengejar ketertinggalan itu.
//
// Cara pakai:
//  - Otomatis: scheduler memanggil backfillSentimentBatch() berkala (lihat
//    lifecycle.js) untuk menilai sedikit-demi-sedikit tanpa membebani LLM.
//  - Manual: endpoint admin POST /api/insights/backfill-sentiment memicu
//    backfillForConversation(id) atau batch global.
//
// Setelah skor pesan diperbarui, avg_sentiment customer ikut dihitung ulang.
// =====================================================================

import { query } from '../db/index.js';
import { analyzeSentiment } from './llm.js';

// Hitung ulang sentimen "representatif" customer (dipakai dashboard, daftar, panel,
// dan targeting broadcast negatif). BUKAN rata-rata polos: rata-rata membuat pesan
// basa-basi netral mengencerkan sedikit pesan yang sangat negatif, sehingga pelanggan
// yang komplain/marah tampak "netral" dan luput dari perhatian. Di sini kita campur
// rata-rata dengan sentimen TERENDAH (paling negatif), sehingga satu keluhan kuat
// ("saya kena tipu") cukup untuk menandai pelanggan sebagai negatif.
async function recomputeCustomerAvg(customerId) {
  await query(
    `UPDATE customers SET avg_sentiment = sub.score
       FROM (
         SELECT
           CASE WHEN COUNT(*)=0 THEN NULL
                ELSE ROUND((
                  LEAST(
                    0.5*AVG(m.sentiment) + 0.5*MIN(m.sentiment),
                    CASE WHEN MIN(m.sentiment) <= -0.3 THEN 0.6*MIN(m.sentiment) ELSE 1 END
                  )
                )::numeric, 3)
           END AS score
           FROM messages m JOIN conversations c ON c.id = m.conversation_id
          WHERE c.customer_id = $1 AND m.sender_type = 'customer' AND m.sentiment IS NOT NULL
       ) sub
     WHERE id = $1`,
    [customerId]
  );
}

// Skor satu pesan & simpan. Mengembalikan true bila berhasil dinilai.
async function scoreMessage(msg) {
  if (!msg.body || !msg.body.trim()) {
    // Pesan tanpa teks (mis. hanya media): tandai netral agar tidak dipindai ulang terus.
    await query('UPDATE messages SET sentiment = 0 WHERE id = $1', [msg.id]);
    return false;
  }
  const s = await analyzeSentiment(msg.body).catch(() => null);
  // Gagal menilai (mis. 429): JANGAN tulis 0. Biarkan sentiment tetap NULL agar
  // dicoba lagi di putaran berikutnya — mencegah seluruh data terkunci 'netral'.
  if (!s || s.score == null) return false;
  await query('UPDATE messages SET sentiment = $1 WHERE id = $2', [s.score, msg.id]);
  return true;
}

// Backfill seluruh percakapan tertentu (dipakai saat membuka chat / tombol manual).
// force=true -> nilai ULANG semua pesan customer (mis. setelah prompt sentimen diperbaiki).
// Mengembalikan jumlah pesan yang dinilai.
export async function backfillForConversation(conversationId, { max = 200, force = false } = {}) {
  const cond = force ? '' : 'AND m.sentiment IS NULL';
  const { rows } = await query(
    `SELECT m.id, m.body, c.customer_id
       FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE m.conversation_id = $1 AND m.sender_type = 'customer' ${cond}
      ORDER BY COALESCE(m.wa_timestamp, m.created_at) ASC, m.id ASC LIMIT $2`,
    [conversationId, max]
  );
  let scored = 0;
  const customers = new Set();
  for (const m of rows) {
    const ok = await scoreMessage(m);
    if (ok) scored++;
    customers.add(m.customer_id);
  }
  for (const cid of customers) await recomputeCustomerAvg(cid);
  return scored;
}

// Backfill batch global lintas semua percakapan (dipakai scheduler, sedikit demi sedikit).
// batchSize kecil agar tidak menghabiskan kuota LLM dalam satu putaran.
export async function backfillSentimentBatch({ batchSize = 25 } = {}) {
  const { rows } = await query(
    `SELECT m.id, m.body, c.customer_id
       FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE m.sender_type = 'customer' AND m.sentiment IS NULL
      ORDER BY COALESCE(m.wa_timestamp, m.created_at) ASC, m.id ASC LIMIT $1`,
    [batchSize]
  );
  if (!rows.length) return { scored: 0, remaining: 0 };

  let scored = 0;
  const customers = new Set();
  for (const m of rows) {
    const ok = await scoreMessage(m);
    if (ok) scored++;
    customers.add(m.customer_id);
  }
  for (const cid of customers) await recomputeCustomerAvg(cid);

  const remaining = (await query(
    `SELECT COUNT(*)::int AS n FROM messages
      WHERE sender_type='customer' AND sentiment IS NULL`
  )).rows[0].n;

  return { scored, remaining };
}

// Berapa banyak pesan customer yang masih belum dinilai (untuk info admin).
export async function pendingSentimentCount() {
  const r = (await query(
    `SELECT COUNT(*)::int AS n FROM messages
      WHERE sender_type='customer' AND sentiment IS NULL`
  )).rows[0];
  return r.n;
}
