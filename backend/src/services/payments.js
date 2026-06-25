// =====================================================================
// Pembayaran: buat tagihan untuk booking, hasilkan link/QRIS, verifikasi.
// Tidak mengikat ke satu payment gateway tertentu — mendukung:
//  - QRIS statis (tempel URL gambar QR di settings 'payment_info')
//  - transfer bank manual (customer kirim bukti -> staf/AI verifikasi)
// Bila Anda punya gateway (Midtrans/Xendit), pay_url bisa diisi URL invoice gateway.
// =====================================================================
import { query } from '../db/index.js';
import { getSetting } from './settings.js';
import { readPaymentProof } from './llm.js';
import fs from 'fs';
import path from 'path';

const MEDIA_DIR = process.env.MEDIA_DIR || '/app/media';

function genRef() {
  return 'PAY-' + Math.random().toString(36).slice(2, 8).toUpperCase();
}

// Buat (atau ambil) tagihan untuk sebuah booking.
export async function createPaymentForBooking(bookingId, { method = 'qris', baseUrl = '' } = {}) {
  const b = (await query('SELECT * FROM bookings WHERE id=$1', [bookingId])).rows[0];
  if (!b) throw new Error('Booking tidak ditemukan');

  // Bila sudah ada tagihan aktif, kembalikan itu (idempoten).
  const existing = (await query(
    `SELECT * FROM payments WHERE booking_id=$1 AND status IN ('unpaid','pending_verify') ORDER BY id DESC LIMIT 1`,
    [bookingId]
  )).rows[0];
  if (existing) return existing;

  const info = await getSetting('payment_info', {});
  const expireHours = Number(info.expire_hours || 24);
  const ref = genRef();
  // pay_url: halaman ringkas yang melayani backend (lihat endpoint GET /pay/:ref)
  const payUrl = baseUrl ? `${baseUrl.replace(/\/$/, '')}/pay/${ref}` : `/pay/${ref}`;

  const { rows } = await query(
    `INSERT INTO payments (booking_id, amount, method, status, reference, pay_url, expires_at)
     VALUES ($1,$2,$3,'unpaid',$4,$5, now() + make_interval(hours => $6)) RETURNING *`,
    [bookingId, b.amount, method, ref, payUrl, expireHours]
  );
  return rows[0];
}

export async function getPaymentByRef(ref) {
  const { rows } = await query(
    `SELECT p.*, b.code AS booking_code, b.service_type, b.status AS booking_status,
            cu.name AS customer_name, cu.phone
       FROM payments p
       JOIN bookings b ON b.id=p.booking_id
       JOIN customers cu ON cu.id=b.customer_id
      WHERE p.reference=$1`, [ref]);
  return rows[0];
}

export async function listPayments({ status, bookingId } = {}) {
  const cond = [], params = [];
  if (status) { params.push(status); cond.push(`p.status=$${params.length}`); }
  if (bookingId) { params.push(bookingId); cond.push(`p.booking_id=$${params.length}`); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const { rows } = await query(
    `SELECT p.*, b.code AS booking_code, cu.name AS customer_name, cu.phone
       FROM payments p JOIN bookings b ON b.id=p.booking_id JOIN customers cu ON cu.id=b.customer_id
       ${where} ORDER BY p.id DESC LIMIT 100`, params);
  return rows;
}

// Customer menandai sudah bayar / mengunggah bukti -> tunggu verifikasi.
export async function markPendingVerify(ref, proofUrl = null) {
  const { rows } = await query(
    `UPDATE payments SET status='pending_verify', proof_url=COALESCE($2, proof_url)
      WHERE reference=$1 AND status='unpaid' RETURNING *`, [ref, proofUrl]);
  return rows[0];
}

// Staf/AI mengonfirmasi pembayaran lunas -> booking jadi 'paid'.
export async function confirmPaid(paymentId) {
  const p = (await query('SELECT * FROM payments WHERE id=$1', [paymentId])).rows[0];
  if (!p) throw new Error('Tagihan tidak ditemukan');
  await query(`UPDATE payments SET status='paid', paid_at=now() WHERE id=$1`, [paymentId]);
  await query(`UPDATE bookings SET status='paid' WHERE id=$1`, [p.booking_id]);
  return { ok: true, bookingId: p.booking_id };
}

// Kadaluarsa otomatis (dipanggil scheduler).
export async function expireOverdue() {
  const { rows } = await query(
    `UPDATE payments SET status='expired'
      WHERE status='unpaid' AND expires_at IS NOT NULL AND expires_at < now()
      RETURNING id, booking_id`);
  return rows;
}

// Teks instruksi pembayaran untuk dikirim ke WhatsApp customer.
export async function paymentInstructionText(payment) {
  const info = await getSetting('payment_info', {});
  const rp = 'Rp' + Number(payment.amount || 0).toLocaleString('id-ID');
  const lines = [
    `💳 Tagihan ${payment.reference} sebesar *${rp}*.`,
  ];
  if (info.qris_image_url) {
    lines.push(`Scan QRIS: ${info.qris_image_url}`);
  }
  if (info.bank_account) {
    lines.push(`Atau transfer ke ${info.bank_name} ${info.bank_account} a.n. ${info.bank_holder}.`);
  }
  if (payment.pay_url) lines.push(`Detail & konfirmasi: ${payment.pay_url}`);
  lines.push(info.note || 'Setelah bayar, kirim bukti ke chat ini untuk verifikasi ya 🙏');
  return lines.join('\n');
}

// Tagihan aktif (unpaid/pending_verify) terbaru untuk sebuah percakapan.
export async function pendingPaymentForConversation(conversationId) {
  const { rows } = await query(
    `SELECT p.* FROM payments p
       JOIN bookings b ON b.id = p.booking_id
      WHERE b.conversation_id = $1 AND p.status IN ('unpaid','pending_verify')
      ORDER BY p.id DESC LIMIT 1`,
    [conversationId]
  );
  return rows[0] || null;
}

// Baca bukti transfer (file gambar relatif terhadap MEDIA_DIR atau '/media/xxx').
// Menyimpan hasil ke payment & menandai 'pending_verify'. Mengembalikan hasil baca.
export async function verifyProofImage(payment, mediaUrl) {
  // Resolusi path file di disk
  const fname = path.basename(mediaUrl || '');
  const full = path.join(MEDIA_DIR, fname);
  let base64, mimetype = 'image/jpeg';
  try {
    const buf = fs.readFileSync(full);
    base64 = buf.toString('base64');
    const ext = (fname.split('.').pop() || 'jpg').toLowerCase();
    mimetype = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  } catch (e) {
    return { ok: false, error: 'File bukti tidak ditemukan' };
  }

  const info = await getSetting('payment_info', {});
  const expectBank = info.bank_name && info.bank_account
    ? `${info.bank_name} ${info.bank_account} a.n. ${info.bank_holder || ''}`.trim()
    : null;

  const result = await readPaymentProof({
    base64, mimetype, expectAmount: payment.amount, expectBank,
  });

  // Simpan hasil & set status menunggu verifikasi (staf tetap konfirmasi final).
  await query(
    `UPDATE payments
        SET status = CASE WHEN status='unpaid' THEN 'pending_verify' ELSE status END,
            proof_url = COALESCE($2, proof_url),
            proof_amount = $3, proof_bank = $4, proof_time = $5,
            proof_match = $6, proof_note = $7
      WHERE id = $1`,
    [payment.id, mediaUrl || null, result.amount, result.bank, result.time, result.match, result.note]
  );

  return { ok: true, result };
}
