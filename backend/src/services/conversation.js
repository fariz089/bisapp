import { query } from '../db/index.js';
import { aiReply, analyzeSentiment, summarizeCustomer, detectLanguage, aiFollowupAfterAction, parseCsatScore } from './llm.js';
import { ticketContextForAI, createAkapBooking, bookedSeats, createCharterBooking } from './tickets.js';
import { createPaymentForBooking, paymentInstructionText, pendingPaymentForConversation, verifyProofImage } from './payments.js';
import { businessHoursStatus } from './settings.js';
import { pickAgentForHandover } from './escalation.js';
import { getSetting, isAiEnabled } from './settings.js';

const PUBLIC_URL = process.env.PUBLIC_URL || ''; // utk link pembayaran absolut (opsional)

// ============ Eksekutor aksi AI ([[ACTION:{...}]]) ============
// Mengembalikan { note } -> catatan untuk AI sampaikan ke customer, atau null.
async function executeAiAction(action, { convo, customer }) {
  try {
    if (action.tool === 'cek_jadwal') {
      // sekadar memastikan; konteks jadwal sudah disuntik ke prompt, jadi cukup no-op informatif
      return { note: 'Jadwal terbaru sudah ditampilkan. Lanjutkan bantu customer memilih.' };
    }

    if (action.tool === 'buat_booking_akap') {
      const schedId = +action.jadwal_id;
      const count = Math.max(1, +action.jumlah_kursi || 1);
      if (!schedId) return { note: 'Booking gagal: jadwal belum dipilih.' };
      // pilih kursi kosong otomatis
      const sched = (await query(
        `SELECT s.*, b.total_seats FROM schedules s JOIN buses b ON b.id=s.bus_id WHERE s.id=$1`, [schedId]
      )).rows[0];
      if (!sched) return { note: 'Booking gagal: jadwal tidak ditemukan.' };
      const taken = new Set(await bookedSeats(schedId));
      const seats = [];
      for (let n = 1; n <= sched.total_seats && seats.length < count; n++) {
        if (!taken.has(n)) seats.push(n);
      }
      if (seats.length < count) return { note: `Maaf, sisa kursi tidak cukup (butuh ${count}).` };
      if (action.nama && !customer.name) {
        await query('UPDATE customers SET name=$1 WHERE id=$2', [action.nama, customer.id]);
      }
      const booking = await createAkapBooking({
        scheduleId: schedId, seats, customerId: customer.id,
        conversationId: convo.id, agentId: null, pax: count,
      });
      return {
        note: `Booking AKAP berhasil dibuat. Kode: ${booking.code}, kursi ${seats.join(', ')}, ` +
          `total Rp${Number(booking.amount).toLocaleString('id-ID')}. ` +
          `Sampaikan kode ini ke customer & tawarkan lanjut ke pembayaran.`,
        booking,
      };
    }

    if (action.tool === 'buat_booking_pariwisata') {
      const charterId = +action.paket_id;
      if (!charterId) return { note: 'Booking gagal: paket belum dipilih.' };
      if (action.nama && !customer.name) {
        await query('UPDATE customers SET name=$1 WHERE id=$2', [action.nama, customer.id]);
      }
      const booking = await createCharterBooking({
        charterId, customerId: customer.id, conversationId: convo.id, agentId: null,
        startDate: action.tanggal || null, days: +action.hari || 1,
        destination: action.tujuan || null, pax: +action.jumlah_orang || null,
      });
      return {
        note: `Booking Pariwisata dibuat. Kode: ${booking.code}, total Rp${Number(booking.amount).toLocaleString('id-ID')}. ` +
          `Sampaikan kode & tawarkan pembayaran (DP/lunas sesuai kebijakan).`,
        booking,
      };
    }

    if (action.tool === 'minta_pembayaran') {
      let bookingId = action.booking_id ? +action.booking_id : null;
      if (!bookingId && action.booking_kode) {
        const r = (await query('SELECT id FROM bookings WHERE code=$1', [action.booking_kode])).rows[0];
        bookingId = r?.id;
      }
      if (!bookingId) {
        // ambil booking terakhir percakapan ini
        const r = (await query(
          'SELECT id FROM bookings WHERE conversation_id=$1 ORDER BY id DESC LIMIT 1', [convo.id])).rows[0];
        bookingId = r?.id;
      }
      if (!bookingId) return { note: 'Belum ada booking untuk ditagih.' };
      const payment = await createPaymentForBooking(bookingId, { baseUrl: PUBLIC_URL });
      const instr = await paymentInstructionText(payment);
      // kirim instruksi pembayaran sebagai pesan terpisah agar rapi
      return { note: 'Kirim instruksi pembayaran berikut apa adanya ke customer:\n' + instr, payment, instr };
    }

    return null;
  } catch (e) {
    console.error('[ai-action] gagal:', e.message);
    return { note: 'Aksi gagal diproses: ' + e.message + '. Mohon bantu secara manual atau serahkan ke staf.' };
  }
}

// Validasi MSISDN: hanya angka, 8–15 digit (E.164). Selain itu -> null.
function validPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  return (d.length >= 8 && d.length <= 15) ? d : null;
}
// Telepon "tampilan" dari wa_id HANYA bila wa_id berbasis @c.us. @lid/@g.us -> null
// (digitnya BUKAN nomor telepon, jadi jangan dijadikan phone).
function phoneFromWaId(waId) {
  if (!waId || !String(waId).endsWith('@c.us')) return null;
  return validPhone(String(waId).split('@')[0]);
}

// Ambil/insert customer.
// phoneHint: nomor telepon yang sudah diresolve WA service (bisa null untuk @lid).
async function getOrCreateCustomer(waId, name, phoneHint) {
  // Nomor terbaik yang kita punya: hint tervalidasi, atau dari wa_id bila @c.us.
  const phone = validPhone(phoneHint) || phoneFromWaId(waId);

  let { rows } = await query('SELECT * FROM customers WHERE wa_id=$1', [waId]);
  if (rows.length) {
    // Bila dulu phone kosong/aneh tapi sekarang sudah tahu nomor asli, lengkapi.
    if (phone && rows[0].phone !== phone) {
      await query('UPDATE customers SET phone=$1 WHERE id=$2', [phone, rows[0].id]).catch(() => {});
      rows[0].phone = phone;
    }
    return rows[0];
  }
  // ON CONFLICT DO NOTHING menangani race condition saat dua webhook untuk
  // wa_id yang sama datang hampir bersamaan (umum terjadi saat sync riwayat).
  ({ rows } = await query(
    `INSERT INTO customers (wa_id, phone, name) VALUES ($1,$2,$3)
     ON CONFLICT (wa_id) DO NOTHING RETURNING *`,
    [waId, phone, name || null]   // phone bisa null — itu BENAR untuk @lid
  ));
  if (rows.length) return rows[0];
  ({ rows } = await query('SELECT * FROM customers WHERE wa_id=$1', [waId]));
  return rows[0];
}

// Ambil/insert percakapan aktif
async function getOrCreateConversation(accountId, customerId) {
  let { rows } = await query(
    `SELECT * FROM conversations
     WHERE account_id=$1 AND customer_id=$2 AND status<>'resolved'
     ORDER BY id DESC LIMIT 1`,
    [accountId, customerId]
  );
  if (rows.length) return rows[0];
  ({ rows } = await query(
    `INSERT INTO conversations (account_id, customer_id) VALUES ($1,$2) RETURNING *`,
    [accountId, customerId]
  ));
  return rows[0];
}

async function getAccountBySession(session) {
  const { rows } = await query('SELECT * FROM wa_accounts WHERE session=$1', [session]);
  return rows[0];
}

async function getHistory(conversationId, limit = 20) {
  const { rows } = await query(
    `SELECT sender_type, body FROM messages
      WHERE conversation_id=$1
      ORDER BY COALESCE(wa_timestamp, created_at) DESC, id DESC LIMIT $2`,
    [conversationId, limit]
  );
  return rows.reverse();
}

async function getKnowledge() {
  const { rows } = await query('SELECT category, question, answer FROM knowledge WHERE active=true LIMIT 50');
  return rows;
}

// Simpan pesan
async function saveMessage(m) {
  // wa_timestamp: untuk pesan WhatsApp gunakan epoch detik aslinya; untuk pesan
  // keluar yang kita buat sendiri (AI/agent), pakai waktu sekarang. Ini yang
  // dipakai untuk MENGURUTKAN transkrip agar sesuai kejadian nyata.
  const waTs = m.wa_timestamp != null
    ? new Date(Number(m.wa_timestamp) * 1000).toISOString()
    : null;
  const { rows } = await query(
    `INSERT INTO messages
       (conversation_id, account_id, wa_message_id, direction, sender_type, agent_id, body, media_type, media_url, sentiment, wa_timestamp)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11, now()))
     ON CONFLICT (account_id, wa_message_id) WHERE wa_message_id IS NOT NULL DO NOTHING
     RETURNING *`,
    [m.conversation_id, m.account_id, m.wa_message_id || null, m.direction, m.sender_type,
     m.agent_id || null, m.body || null, m.media_type || null, m.media_url || null, m.sentiment ?? null, waTs]
  );
  return rows[0];
}

// ============ Handler utama pesan MASUK dari WA service ============
// io: socket.io untuk push realtime ke dashboard
// sendFn: async (session, waId, text) => kirim balasan via WA service
export async function handleIncoming({ session, waId, phone, name, body, waMessageId, waTimestamp, mediaType, mediaUrl, mediaName, historical, fromMe }, io, sendFn) {
  const account = await getAccountBySession(session);
  if (!account) return;

  const customer = await getOrCreateCustomer(waId, name, phone);
  const convo = await getOrCreateConversation(account.id, customer.id);

  // Pesan keluar historis (fromMe) saat sinkronisasi: simpan sebagai transkrip, jangan picu AI
  if (historical && fromMe) {
    await saveMessage({
      conversation_id: convo.id, account_id: account.id, wa_message_id: waMessageId,
      direction: 'out', sender_type: 'agent', body,
      media_type: mediaType, media_url: mediaUrl, wa_timestamp: waTimestamp,
    });
    return;
  }

  // Sentimen (hanya untuk pesan customer non-historis agar hemat kuota LLM)
  let sentiment = null;
  if (body && !historical) {
    const s = await analyzeSentiment(body).catch(() => null);
    sentiment = s?.score ?? null;
  }

  const inMsg = await saveMessage({
    conversation_id: convo.id, account_id: account.id, wa_message_id: waMessageId,
    direction: 'in', sender_type: 'customer', body, media_type: mediaType, media_url: mediaUrl, sentiment,
    wa_timestamp: waTimestamp,
  });

  // Pesan historis masuk: cukup simpan, jangan picu balasan AI
  if (historical) {
    if (inMsg) io?.emit('message:new', { conversationId: convo.id, accountId: account.id, message: inMsg });
    return;
  }

  await query('UPDATE conversations SET last_message_at=now() WHERE id=$1', [convo.id]);
  await query('UPDATE customers SET total_chats=total_chats+1, updated_at=now() WHERE id=$1', [customer.id]);

  // Pesan dari customer: reset siklus follow-up & tandai customer sbg pengirim terakhir.
  // Bila sebelumnya AI sempat mengirim nudge, hitungan di-nol-kan agar siklus mulai ulang.
  await query(
    `UPDATE conversations SET last_sender='customer', followups_sent=0, last_followup_at=NULL WHERE id=$1`,
    [convo.id]
  );

  // Perbarui rata-rata sentimen customer (dipakai dashboard & panel mood).
  // Dihitung dari seluruh pesan customer yang sudah punya skor.
  if (sentiment != null) {
    await query(
      `UPDATE customers SET avg_sentiment = (
         SELECT ROUND(AVG(m.sentiment)::numeric, 3)
           FROM messages m JOIN conversations c ON c.id=m.conversation_id
          WHERE c.customer_id=$1 AND m.sender_type='customer' AND m.sentiment IS NOT NULL
       ) WHERE id=$1`,
      [customer.id]
    );
  }

  if (inMsg) io?.emit('message:new', { conversationId: convo.id, accountId: account.id, message: inMsg });

  // ===== Tangkap rating CSAT =====
  // Bila customer baru saja diminta menilai (sesi sebelumnya ditutup) dan membalas angka 1-5,
  // simpan sebagai skor CSAT pada percakapan yang menunggu rating itu, lalu ucapkan terima kasih.
  if (body) {
    const score = parseCsatScore(body);
    if (score != null) {
      const pendingCsat = (await query(
        `SELECT id FROM conversations
          WHERE customer_id=$1 AND csat_token IS NOT NULL AND csat_score IS NULL
            AND resolved_at > now() - interval '24 hours'
          ORDER BY resolved_at DESC LIMIT 1`, [customer.id]
      )).rows[0];
      if (pendingCsat) {
        await query(
          `UPDATE conversations SET csat_score=$2, csat_at=now(), csat_token=NULL WHERE id=$1`,
          [pendingCsat.id, score]
        );
        io?.emit('csat:new', { conversationId: pendingCsat.id, score });
        const csatCfg = await getSetting('csat', {});
        const thanks = csatCfg.thanks_message || 'Terima kasih atas penilaiannya 🙏';
        await sendFn(session, waId, thanks).catch(() => {});
        const tm = await saveMessage({
          conversation_id: convo.id, account_id: account.id,
          direction: 'out', sender_type: 'ai', body: thanks,
        });
        if (tm) io?.emit('message:new', { conversationId: convo.id, accountId: account.id, message: tm });
        // Tutup percakapan baru ini lagi (hanya dibuat karena customer membalas rating).
        await query(`UPDATE conversations SET status='resolved', resolved_at=now(), close_reason='csat_reply' WHERE id=$1`, [convo.id]);
        return;
      }
    }
  }

  // Deteksi bahasa customer (sekali, lalu disimpan) untuk balasan AI multi-bahasa.
  let lang = convo.lang;
  if (!lang && body) {
    lang = await detectLanguage(body).catch(() => 'id');
    await query('UPDATE conversations SET lang=$1 WHERE id=$2', [lang, convo.id]);
  }

  // Saklar global AI: bila admin mematikan AI dari Pengaturan, AI tidak membalas
  // siapa pun. Pesan tetap tersimpan & masuk dashboard untuk dijawab manual oleh staf.
  const aiEnabled = await isAiEnabled();

  // ===== Bukti transfer (gambar) =====
  // Bila customer mengirim GAMBAR dan ada tagihan aktif di percakapan ini, AI membaca
  // bukti & mengisi pra-verifikasi. Berlaku di mode AI maupun human (membantu staf).
  const isImage = mediaUrl && /^(image|sticker|ptt)?/.test(mediaType || '') &&
                  /\.(jpg|jpeg|png|webp)$/i.test(mediaUrl);
  if (isImage) {
    const pending = await pendingPaymentForConversation(convo.id).catch(() => null);
    if (pending) {
      const { ok, result } = await verifyProofImage(pending, mediaUrl).catch(() => ({ ok: false }));
      if (ok && result) {
        io?.emit('payment:proof', { conversationId: convo.id, paymentId: pending.id, match: result.match });
        io?.emit('payment:update', { id: pending.id, status: 'pending_verify' });
        // Beri tanggapan ke customer sesuai hasil baca (tetap minta staf konfirmasi final).
        let ack;
        if (result.match === 'match') {
          ack = 'Terima kasih, bukti pembayaran sudah kami terima dan sedang kami verifikasi ya 🙏 ' +
                'Mohon tunggu konfirmasi dari kami sebentar.';
        } else if (result.match === 'mismatch') {
          ack = 'Terima kasih sudah mengirim bukti. Sepertinya ada yang perlu kami cek dulu ' +
                '(nominal/detail belum cocok). Tim kami akan segera memverifikasi ya 🙏';
        } else {
          ack = 'Terima kasih, bukti sudah kami terima. Gambar akan kami periksa manual oleh tim ya 🙏';
        }
        // Mode AI: kirim ack otomatis. Mode human / AI dimatikan: biar agen yang menanggapi.
        if (convo.mode === 'ai' && aiEnabled) {
          await sendFn(session, waId, ack);
          const am = await saveMessage({
            conversation_id: convo.id, account_id: account.id,
            direction: 'out', sender_type: 'ai', body: ack,
          });
          await query(`UPDATE conversations SET last_sender='ai', last_message_at=now() WHERE id=$1`, [convo.id]);
          if (am) io?.emit('message:new', { conversationId: convo.id, accountId: account.id, message: am });
        }
        // Bila tidak cocok / tidak jelas, eskalasi agar staf memeriksa.
        if (result.match !== 'match') {
          await escalate(convo, account, io, 'proof_review');
        }
        return;
      }
    }
  }

  // Jika mode human -> jangan balas AI, biarkan karyawan
  if (convo.mode === 'human') {
    io?.emit('conversation:update', { conversationId: convo.id });
    return;
  }

  // Saklar global AI dimatikan -> AI tidak membalas siapa pun.
  // Pesan sudah tersimpan & dikirim ke dashboard; staf membalas manual.
  if (!aiEnabled) {
    io?.emit('conversation:update', { conversationId: convo.id });
    return;
  }

  // Media tanpa teks (mis. customer kirim foto lain): serahkan ke agen
  if (!body && mediaUrl) {
    await escalate(convo, account, io, 'media');
    return;
  }

  // Mode AI -> balas otomatis
  if (!body) return; // pesan kosong: lewati
  try {
    const hours = await businessHoursStatus().catch(() => ({ open: true }));
    const history = await getHistory(convo.id, 14);
    const knowledge = await getKnowledge();
    const ticketCtx = await ticketContextForAI().catch(() => null);
    const { reply, handover, action } = await aiReply({
      knowledge, accountLabel: account.label, history, userText: body, ticketCtx,
      lang, afterHours: !hours.open,
    });

    // Kirim balasan utama AI dulu
    if (reply) {
      await sendFn(session, waId, reply);
      const outMsg = await saveMessage({
        conversation_id: convo.id, account_id: account.id,
        direction: 'out', sender_type: 'ai', body: reply,
      });
      await query(`UPDATE conversations SET last_sender='ai', last_message_at=now() WHERE id=$1`, [convo.id]);
      if (outMsg) io?.emit('message:new', { conversationId: convo.id, accountId: account.id, message: outMsg });
    }

    // Eksekusi aksi bila ada (buat booking / minta pembayaran / dll)
    if (action) {
      const result = await executeAiAction(action, { convo, customer });
      if (result?.note) {
        // Untuk minta_pembayaran kita kirim instruksi apa adanya; selain itu AI merangkum natural.
        let followText;
        if (action.tool === 'minta_pembayaran' && result.instr) {
          followText = result.instr;
        } else {
          const h2 = await getHistory(convo.id, 8);
          followText = await aiFollowupAfterAction({
            accountLabel: account.label, history: h2, systemNote: result.note, lang,
          }).catch(() => null);
        }
        if (followText) {
          await sendFn(session, waId, followText);
          const am = await saveMessage({
            conversation_id: convo.id, account_id: account.id,
            direction: 'out', sender_type: 'ai', body: followText,
          });
          await query(`UPDATE conversations SET last_sender='ai', last_message_at=now() WHERE id=$1`, [convo.id]);
          if (am) io?.emit('message:new', { conversationId: convo.id, accountId: account.id, message: am });
        }
        // booking baru -> beri tahu dashboard agar kartu penjualan menyegar
        if (result.booking) io?.emit('booking:new', { conversationId: convo.id, code: result.booking.code });
      }
    }

    // Eskalasi bila AI minta handover
    if (handover) {
      await escalate(convo, account, io, 'ai_handover');
    }
  } catch (e) {
    console.error('[ai] gagal membalas:', e.message);
    await escalate(convo, account, io, 'ai_error');
  }

  // Update profil perilaku customer secara berkala.
  // PENTING: `customer.total_chats` di-load SEBELUM increment di atas, jadi sudah
  // basi. Ambil nilai terbaru agar gate-nya akurat. Jalankan saat pesan pertama
  // (agar arketipe cepat terisi, tidak stuck 'netral') lalu tiap kelipatan 5.
  const freshChats = (await query(
    'SELECT total_chats FROM customers WHERE id=$1', [customer.id]
  )).rows[0]?.total_chats || 0;
  if (freshChats === 1 || freshChats % 5 === 0) {
    const histProfile = await getHistory(convo.id, 30);
    const prof = await summarizeCustomer(histProfile).catch(() => null);
    // Hanya tulis bila LLM benar-benar memberi tag (summarizeCustomer kini
    // mengembalikan null saat gagal / rate limit, agar tidak menimpa data bagus).
    if (prof && prof.behavior_tag) {
      await query('UPDATE customers SET behavior_tag=$1, behavior_note=$2 WHERE id=$3',
        [prof.behavior_tag, prof.note, customer.id]);
    }
  }
}

// ============ Eskalasi pintar ke manusia ============
// Set mode human + pending, lalu coba auto-assign ke agen online paling longgar.
async function escalate(convo, account, io, reason) {
  await query(`UPDATE conversations SET mode='human', status='pending' WHERE id=$1`, [convo.id]);
  let assigned = null;
  try {
    assigned = await pickAgentForHandover();
    if (assigned) {
      await query('UPDATE conversations SET assigned_agent=$1 WHERE id=$2', [assigned.id, convo.id]);
    }
  } catch (e) { console.error('[escalate] auto-assign gagal:', e.message); }
  io?.emit('conversation:handover', {
    conversationId: convo.id, accountId: account.id, reason, assignedAgent: assigned?.id || null,
  });
  if (assigned) io?.emit('agent:assigned', { conversationId: convo.id, agentId: assigned.id, agentName: assigned.name });
}

// Pesan keluar dari KARYAWAN (via dashboard)
export async function sendAsAgent({ conversationId, agentId, text }, io, sendFn) {
  const { rows } = await query(
    `SELECT c.*, a.session, cu.wa_id
       FROM conversations c
       JOIN wa_accounts a ON a.id=c.account_id
       JOIN customers cu ON cu.id=c.customer_id
      WHERE c.id=$1`, [conversationId]);
  const convo = rows[0];
  if (!convo) throw new Error('Percakapan tidak ditemukan');

  await sendFn(convo.session, convo.wa_id, text);

  const out = await saveMessage({
    conversation_id: conversationId, account_id: convo.account_id,
    direction: 'out', sender_type: 'agent', agent_id: agentId, body: text,
  });

  // Catat waktu respons pertama untuk KPI
  if (!convo.first_reply_sec) {
    await query(
      `UPDATE conversations
         SET first_reply_sec = EXTRACT(EPOCH FROM (now()-created_at))::int
       WHERE id=$1`, [conversationId]);
  }
  // Karyawan baru membalas -> menunggu customer. Reset siklus follow-up.
  await query(
    `UPDATE conversations SET last_message_at=now(), last_sender='agent', followups_sent=0 WHERE id=$1`,
    [conversationId]
  );

  if (out) io?.emit('message:new', { conversationId, accountId: convo.account_id, message: out });
  return out;
}

export { getHistory };