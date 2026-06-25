import { pool, query } from '../db/index.js';

function genCode(prefix = 'BUS') {
  const s = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${prefix}-${s}`;
}

// ---------- Pencarian jadwal AKAP ----------
export async function searchSchedules({ origin, destination, date }) {
  const params = [];
  const cond = [`s.status='open'`];
  if (origin) { params.push(`%${origin}%`); cond.push(`r.origin ILIKE $${params.length}`); }
  if (destination) { params.push(`%${destination}%`); cond.push(`r.destination ILIKE $${params.length}`); }
  if (date) { params.push(date); cond.push(`s.departure_date = $${params.length}`); }
  const { rows } = await query(
    `SELECT s.id, r.origin, r.destination, s.departure_date, s.departure_time,
            s.price, b.name AS bus_name, b.bus_class, b.total_seats,
            b.total_seats - COALESCE((SELECT COUNT(*) FROM seat_bookings sb WHERE sb.schedule_id=s.id),0) AS seats_available
       FROM schedules s
       JOIN routes r ON r.id=s.route_id
       JOIN buses b ON b.id=s.bus_id
      WHERE ${cond.join(' AND ')}
      ORDER BY s.departure_date, s.departure_time
      LIMIT 30`, params);
  return rows;
}

// Kursi yang sudah terisi untuk satu jadwal
export async function bookedSeats(scheduleId) {
  const { rows } = await query('SELECT seat_number FROM seat_bookings WHERE schedule_id=$1', [scheduleId]);
  return rows.map(r => r.seat_number);
}

// ---------- Buat booking AKAP (transaksional) ----------
export async function createAkapBooking({ scheduleId, seats, customerId, conversationId, agentId, pax }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Kunci jadwal untuk hindari race
    const sched = (await client.query('SELECT * FROM schedules WHERE id=$1 FOR UPDATE', [scheduleId])).rows[0];
    if (!sched) throw new Error('Jadwal tidak ditemukan');
    if (sched.status !== 'open') throw new Error('Jadwal sudah ditutup');

    const amount = Number(sched.price) * seats.length;
    const code = genCode('AKAP');
    const booking = (await client.query(
      `INSERT INTO bookings (code, service_type, conversation_id, customer_id, agent_id,
                             schedule_id, seat_numbers, pax, amount, status)
       VALUES ($1,'akap',$2,$3,$4,$5,$6,$7,$8,'confirmed') RETURNING *`,
      [code, conversationId || null, customerId, agentId || null, scheduleId, seats, pax || seats.length, amount]
    )).rows[0];

    // Pesan tiap kursi; UNIQUE akan menolak kursi yang sudah dipesan
    for (const seat of seats) {
      await client.query(
        'INSERT INTO seat_bookings (schedule_id, seat_number, booking_id) VALUES ($1,$2,$3)',
        [scheduleId, seat, booking.id]);
    }
    await client.query('COMMIT');
    return booking;
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') throw new Error('Sebagian kursi sudah dipesan orang lain. Coba kursi lain.');
    throw e;
  } finally {
    client.release();
  }
}

// ---------- Pencarian paket carter Pariwisata ----------
export async function searchCharters({ paxMin } = {}) {
  const params = [];
  let cond = 'active=true';
  if (paxMin) { params.push(paxMin); cond += ` AND capacity >= $${params.length}`; }
  const { rows } = await query(
    `SELECT * FROM charter_packages WHERE ${cond} ORDER BY price_per_day LIMIT 30`, params);
  return rows;
}

// ---------- Buat booking Pariwisata ----------
export async function createCharterBooking({ charterId, customerId, conversationId, agentId, startDate, days, destination, pax }) {
  const pkg = (await query('SELECT * FROM charter_packages WHERE id=$1', [charterId])).rows[0];
  if (!pkg) throw new Error('Paket carter tidak ditemukan');
  const amount = Number(pkg.price_per_day) * (days || 1);
  const code = genCode('WISATA');
  const { rows } = await query(
    `INSERT INTO bookings (code, service_type, conversation_id, customer_id, agent_id,
                           charter_id, start_date, days, destination, pax, amount, status)
     VALUES ($1,'pariwisata',$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending') RETURNING *`,
    [code, conversationId || null, customerId, agentId || null, charterId,
     startDate || null, days || 1, destination || null, pax || pkg.capacity, amount]);
  return rows[0];
}

// ---------- Daftar booking ----------
export async function listBookings({ customerId, status } = {}) {
  const params = []; const cond = [];
  if (customerId) { params.push(customerId); cond.push(`b.customer_id=$${params.length}`); }
  if (status) { params.push(status); cond.push(`b.status=$${params.length}`); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const { rows } = await query(
    `SELECT b.*, cu.name AS customer_name, cu.phone,
            r.origin, r.destination AS route_dest, s.departure_date, s.departure_time,
            cp.name AS charter_name
       FROM bookings b
       JOIN customers cu ON cu.id=b.customer_id
       LEFT JOIN schedules s ON s.id=b.schedule_id
       LEFT JOIN routes r ON r.id=s.route_id
       LEFT JOIN charter_packages cp ON cp.id=b.charter_id
       ${where}
      ORDER BY b.created_at DESC LIMIT 100`, params);
  return rows;
}

export async function updateBookingStatus(id, status) {
  await query('UPDATE bookings SET status=$1 WHERE id=$2', [status, id]);
}

// ---------- Ringkasan untuk konteks AI (jadwal & paket aktif) ----------
export async function ticketContextForAI() {
  const sched = await query(
    `SELECT s.id, r.origin, r.destination, s.departure_date, s.departure_time, s.price,
            b.bus_class,
            b.total_seats - COALESCE((SELECT COUNT(*) FROM seat_bookings sb WHERE sb.schedule_id=s.id),0) AS avail
       FROM schedules s JOIN routes r ON r.id=s.route_id JOIN buses b ON b.id=s.bus_id
      WHERE s.status='open' AND s.departure_date >= CURRENT_DATE
      ORDER BY s.departure_date, s.departure_time LIMIT 15`);
  const charter = await query('SELECT id, name, bus_class, price_per_day, capacity, includes FROM charter_packages WHERE active=true LIMIT 10');
  return { schedules: sched.rows, charters: charter.rows };
}

// ---------- Ambil satu booking lengkap (untuk reschedule/cancel/detail) ----------
export async function getBooking(idOrCode) {
  const byCode = typeof idOrCode === 'string' && /[A-Za-z]/.test(idOrCode);
  const { rows } = await query(
    `SELECT b.*, s.departure_date, s.departure_time, s.route_id, s.bus_id,
            r.origin, r.destination, cp.name AS charter_name
       FROM bookings b
       LEFT JOIN schedules s ON s.id=b.schedule_id
       LEFT JOIN routes r ON r.id=s.route_id
       LEFT JOIN charter_packages cp ON cp.id=b.charter_id
      WHERE ${byCode ? 'b.code=$1' : 'b.id=$1'}`,
    [idOrCode]
  );
  return rows[0] || null;
}

// Hitung refund pembatalan AKAP berdasarkan kebijakan (tiers) & sisa hari ke berangkat.
// policy = setting 'refund_policy'. Mengembalikan { refundPct, refundAmount, tier, daysBefore }.
export function computeRefund(booking, policy) {
  const tiers = (policy?.tiers || []).slice().sort((a, b) => b.min_days_before - a.min_days_before);
  let daysBefore = null;
  if (booking.departure_date) {
    const dep = new Date(booking.departure_date + 'T00:00:00');
    const today = new Date(); today.setHours(0, 0, 0, 0);
    daysBefore = Math.round((dep - today) / (24 * 3600 * 1000));
  }
  // Pilih tier tertinggi yang ambangnya <= sisa hari.
  let tier = tiers.find(t => daysBefore != null && daysBefore >= t.min_days_before) || tiers[tiers.length - 1] || { refund_pct: 0, label: '-' };
  const refundPct = Math.max(0, Math.min(100, Number(tier.refund_pct) || 0));
  const paid = Number(booking.amount) || 0;
  const refundAmount = Math.round(paid * refundPct / 100);
  return { refundPct, refundAmount, tier: tier.label || '-', daysBefore };
}

// ---------- Reschedule AKAP: pindah ke jadwal baru (transaksional) ----------
// Melepas kursi lama, memilih kursi baru otomatis, menyesuaikan harga + biaya admin.
export async function rescheduleAkapBooking({ bookingId, newScheduleId, fee = 0, actor = 'agent', agentId = null, reason = null }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const b = (await client.query('SELECT * FROM bookings WHERE id=$1 FOR UPDATE', [bookingId])).rows[0];
    if (!b) throw new Error('Booking tidak ditemukan');
    if (b.service_type !== 'akap') throw new Error('Hanya booking AKAP yang bisa di-reschedule di sini');
    if (b.status === 'cancelled') throw new Error('Booking sudah dibatalkan');

    const oldSchedId = b.schedule_id;
    const seatCount = Array.isArray(b.seat_numbers) ? b.seat_numbers.length : (b.pax || 1);

    const newSched = (await client.query(
      `SELECT s.*, bus.total_seats FROM schedules s JOIN buses bus ON bus.id=s.bus_id WHERE s.id=$1 FOR UPDATE`,
      [newScheduleId]
    )).rows[0];
    if (!newSched) throw new Error('Jadwal baru tidak ditemukan');
    if (newSched.status !== 'open') throw new Error('Jadwal baru tidak tersedia');

    // Kursi terisi di jadwal baru
    const taken = new Set((await client.query(
      'SELECT seat_number FROM seat_bookings WHERE schedule_id=$1', [newScheduleId]
    )).rows.map(r => r.seat_number));
    const newSeats = [];
    for (let n = 1; n <= newSched.total_seats && newSeats.length < seatCount; n++) {
      if (!taken.has(n)) newSeats.push(n);
    }
    if (newSeats.length < seatCount) throw new Error(`Sisa kursi jadwal baru tidak cukup (butuh ${seatCount})`);

    // Lepas kursi lama, pasang kursi baru
    await client.query('DELETE FROM seat_bookings WHERE booking_id=$1', [bookingId]);
    for (const seat of newSeats) {
      await client.query(
        'INSERT INTO seat_bookings (schedule_id, seat_number, booking_id) VALUES ($1,$2,$3)',
        [newScheduleId, seat, bookingId]);
    }

    const newAmount = Number(newSched.price) * seatCount + Number(fee || 0);
    const oldSnap = { schedule_id: oldSchedId, seat_numbers: b.seat_numbers, amount: b.amount };
    const newSnap = { schedule_id: newScheduleId, seat_numbers: newSeats, amount: newAmount };

    await client.query(
      `UPDATE bookings SET schedule_id=$1, seat_numbers=$2, amount=$3, status='confirmed' WHERE id=$4`,
      [newScheduleId, newSeats, newAmount, bookingId]
    );
    await client.query(
      `INSERT INTO booking_changes (booking_id, change_type, old_value, new_value, fee_amount, reason, actor, agent_id)
       VALUES ($1,'reschedule',$2::jsonb,$3::jsonb,$4,$5,$6,$7)`,
      [bookingId, JSON.stringify(oldSnap), JSON.stringify(newSnap), fee || 0, reason, actor, agentId]
    );
    await client.query('COMMIT');
    return { booking: { ...b, schedule_id: newScheduleId, seat_numbers: newSeats, amount: newAmount }, newSeats, newAmount };
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') throw new Error('Kursi jadwal baru keburu dipesan orang lain. Coba lagi.');
    throw e;
  } finally {
    client.release();
  }
}

// ---------- Batalkan booking (AKAP/Pariwisata) + catat refund ----------
export async function cancelBooking({ bookingId, refundAmount = 0, fee = 0, actor = 'agent', agentId = null, reason = null }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const b = (await client.query('SELECT * FROM bookings WHERE id=$1 FOR UPDATE', [bookingId])).rows[0];
    if (!b) throw new Error('Booking tidak ditemukan');
    if (b.status === 'cancelled') throw new Error('Booking sudah dibatalkan');

    // Lepas kursi (AKAP) agar bisa dijual lagi
    if (b.service_type === 'akap') {
      await client.query('DELETE FROM seat_bookings WHERE booking_id=$1', [bookingId]);
    }
    await client.query(`UPDATE bookings SET status='cancelled' WHERE id=$1`, [bookingId]);
    // Batalkan tagihan yang belum dibayar
    await client.query(
      `UPDATE payments SET status='cancelled' WHERE booking_id=$1 AND status IN ('unpaid','pending_verify')`,
      [bookingId]
    );
    await client.query(
      `INSERT INTO booking_changes (booking_id, change_type, old_value, refund_amount, fee_amount, reason, actor, agent_id)
       VALUES ($1,'cancel',$2::jsonb,$3,$4,$5,$6,$7)`,
      [bookingId, JSON.stringify({ status: b.status, amount: b.amount }), refundAmount || 0, fee || 0, reason, actor, agentId]
    );
    await client.query('COMMIT');
    return { ok: true, refundAmount, bookingId };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Riwayat perubahan satu booking
export async function bookingChanges(bookingId) {
  const { rows } = await query(
    `SELECT bc.*, ag.name AS agent_name FROM booking_changes bc
       LEFT JOIN agents ag ON ag.id=bc.agent_id
      WHERE bc.booking_id=$1 ORDER BY bc.id DESC`, [bookingId]);
  return rows;
}
