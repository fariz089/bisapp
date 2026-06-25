import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

export async function query(text, params) {
  return pool.query(text, params);
}

// Jalankan schema.sql + buat akun WA default + admin default
export async function initDb() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);

  // Akun WA default: cs & tiket (sesuaikan label)
  await pool.query(`
    INSERT INTO wa_accounts (session, label) VALUES
      ('cs', 'Customer Service'),
      ('tiket', 'Pemesanan Tiket & Info')
    ON CONFLICT (session) DO NOTHING;
  `);

  // Admin default
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@bis.local';
  const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
  const { rows } = await pool.query('SELECT id FROM agents WHERE email=$1', [adminEmail]);
  if (rows.length === 0) {
    const hash = await bcrypt.hash(adminPass, 10);
    await pool.query(
      `INSERT INTO agents (name, email, password, role) VALUES ($1,$2,$3,'admin')`,
      ['Administrator', adminEmail, hash]
    );
    console.log(`[db] Admin dibuat: ${adminEmail} / ${adminPass}`);
  }

  // Seed contoh data tiket (hanya jika kosong)
  const busCount = await pool.query('SELECT COUNT(*)::int AS n FROM buses');
  if (busCount.rows[0].n === 0) {
    await pool.query(`
      INSERT INTO buses (code,name,bus_class,total_seats,usage_type) VALUES
        ('B-7501-AK','Hino RK8 Bisnis','Bisnis',40,'akap'),
        ('B-7502-AK','Scania K410 Executive','Executive',32,'akap'),
        ('B-9001-PW','Mercedes OH1626 Wisata','Executive',45,'pariwisata');
      INSERT INTO routes (origin,destination,distance_km,base_price) VALUES
        ('Jakarta','Surabaya',780,320000),
        ('Jakarta','Yogyakarta',560,250000),
        ('Bandung','Semarang',430,210000);
      INSERT INTO schedules (route_id,bus_id,departure_date,departure_time,price) VALUES
        (1,1,CURRENT_DATE+1,'18:00',320000),
        (1,2,CURRENT_DATE+1,'20:00',420000),
        (2,1,CURRENT_DATE+2,'19:00',250000);
      INSERT INTO charter_packages (name,bus_class,price_per_day,capacity,includes) VALUES
        ('Carter Harian Dalam Kota','Bisnis',2500000,40,'BBM, sopir, tol dalam kota'),
        ('Carter Luar Kota 2 Hari','Executive',6500000,45,'BBM, 2 sopir, tol, penginapan sopir'),
        ('Carter Wisata Premium','Executive',4000000,32,'BBM, sopir, tol, snack, sound system');
    `);
    console.log('[db] Seed data tiket contoh dibuat.');
  }

  // Pengaturan default: jam kerja & info pembayaran (hanya bila belum ada)
  await pool.query(`
    INSERT INTO settings (key, value) VALUES
      ('business_hours', $1::jsonb),
      ('payment_info',  $2::jsonb),
      ('refund_policy', $3::jsonb),
      ('csat', $4::jsonb)
    ON CONFLICT (key) DO NOTHING;
  `, [
    JSON.stringify({
      enabled: true,
      tz: process.env.TZ || 'Asia/Jakarta',
      // 0=Min .. 6=Sab; open/close format "HH:MM" 24 jam
      days: {
        0: { open: '08:00', close: '17:00', closed: true },
        1: { open: '08:00', close: '20:00', closed: false },
        2: { open: '08:00', close: '20:00', closed: false },
        3: { open: '08:00', close: '20:00', closed: false },
        4: { open: '08:00', close: '20:00', closed: false },
        5: { open: '08:00', close: '20:00', closed: false },
        6: { open: '09:00', close: '15:00', closed: false },
      },
      after_hours_message:
        'Terima kasih sudah menghubungi kami 🙏 Saat ini di luar jam operasional. ' +
        'Pesan Anda kami terima dan akan dibalas staf pada jam kerja berikutnya. ' +
        'Untuk info cepat soal jadwal & harga, silakan tanyakan langsung di sini ya.',
    }),
    JSON.stringify({
      // QRIS statis (tempel URL gambar QR Anda) atau info transfer bank
      qris_image_url: '',
      bank_name: 'BCA',
      bank_account: '1234567890',
      bank_holder: 'PT Otobus Sejahtera',
      note: 'Setelah transfer, kirim bukti ke chat ini untuk verifikasi.',
      expire_hours: 24,
    }),
    JSON.stringify({
      // Kebijakan refund pembatalan AKAP berdasarkan jarak hari ke keberangkatan.
      // refund_pct = persen yang dikembalikan ke customer.
      // Aturan dipilih dari ambang TERTINGGI yang <= sisa hari.
      tiers: [
        { min_days_before: 7, refund_pct: 90, label: 'H-7 atau lebih' },
        { min_days_before: 3, refund_pct: 50, label: 'H-3 s/d H-6' },
        { min_days_before: 1, refund_pct: 25, label: 'H-1 s/d H-2' },
        { min_days_before: 0, refund_pct: 0,  label: 'Hari-H / lewat' },
      ],
      // Biaya administrasi reschedule (flat, Rp). Selisih harga jadwal baru dihitung terpisah.
      reschedule_fee: 25000,
      pariwisata_note: 'Pembatalan paket pariwisata mengikuti kesepakatan kontrak; hubungi staf.',
    }),
    JSON.stringify({
      enabled: true,
      // Dikirim otomatis saat sesi yang sempat ditangani agen ditutup.
      ask_message: 'Terima kasih sudah menghubungi kami 🙏 Boleh beri penilaian layanan kami? ' +
        'Balas dengan angka 1-5 (5 = sangat puas), atau buka: ',
      thanks_message: 'Terima kasih atas penilaiannya! Masukan Anda sangat berarti 🙏',
    }),
  ]);

  console.log('[db] Inisialisasi selesai.');
}