-- =====================================================================
-- Skema Database Sistem CS & Penjualan Tiket Bis (AKAP & Pariwisata)
-- =====================================================================

-- Nomor WhatsApp yang dikelola (mis. CS dan Tiket)
CREATE TABLE IF NOT EXISTS wa_accounts (
  id          SERIAL PRIMARY KEY,
  session     VARCHAR(64) UNIQUE NOT NULL,   -- id sesi, mis. 'cs', 'tiket'
  label       VARCHAR(120) NOT NULL,         -- 'Customer Service', 'Pemesanan Tiket'
  phone       VARCHAR(40),                   -- nomor terdeteksi setelah login
  status      VARCHAR(24) DEFAULT 'disconnected',
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- Karyawan / agent
CREATE TABLE IF NOT EXISTS agents (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(120) NOT NULL,
  email       VARCHAR(160) UNIQUE NOT NULL,
  password    VARCHAR(200) NOT NULL,         -- hash bcrypt
  role        VARCHAR(24) DEFAULT 'agent',   -- 'agent' | 'admin'
  active      BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- Customer (profil + perilaku)
CREATE TABLE IF NOT EXISTS customers (
  id              SERIAL PRIMARY KEY,
  wa_id           VARCHAR(64) UNIQUE NOT NULL, -- mis. 628xxxx@c.us
  phone           VARCHAR(40),
  name            VARCHAR(160),
  -- profil perilaku yang dirangkum AI
  behavior_tag    VARCHAR(40),                -- 'ramah' | 'mudah_marah' | 'cerewet' | 'to_the_point' | 'netral'
  behavior_note   TEXT,                       -- ringkasan AI tentang customer
  avg_sentiment   NUMERIC(4,3),               -- -1.000 .. 1.000
  total_chats     INT DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- Percakapan (1 customer per akun WA bisa banyak percakapan, tapi kita pakai 1 aktif)
CREATE TABLE IF NOT EXISTS conversations (
  id              SERIAL PRIMARY KEY,
  account_id      INT REFERENCES wa_accounts(id),
  customer_id     INT REFERENCES customers(id),
  -- siapa yang menangani sekarang
  mode            VARCHAR(16) DEFAULT 'ai',   -- 'ai' | 'human'
  status          VARCHAR(20) DEFAULT 'open', -- 'open' | 'pending' | 'resolved'
  assigned_agent  INT REFERENCES agents(id),
  intent          VARCHAR(24),                -- 'akap' | 'pariwisata' | 'umum'
  last_message_at TIMESTAMPTZ DEFAULT now(),
  -- siapa yang mengirim pesan terakhir: dipakai scheduler utk tahu apakah customer "diam"
  last_sender     VARCHAR(12) DEFAULT 'customer', -- 'customer' | 'ai' | 'agent'
  first_reply_sec INT,                        -- waktu respons pertama (detik) utk KPI
  -- ===== siklus sesi / follow-up otomatis =====
  followups_sent  INT DEFAULT 0,              -- berapa kali AI sudah menyenggol customer
  last_followup_at TIMESTAMPTZ,               -- kapan nudge terakhir dikirim
  close_reason    VARCHAR(24),                -- 'agent'|'timeout'|'resolved_by_ai'|null
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT now()
);
-- index agar scheduler cepat memindai percakapan yang "menggantung"
CREATE INDEX IF NOT EXISTS idx_conv_open_lastmsg
  ON conversations(status, last_message_at) WHERE status <> 'resolved';

-- Skor mood PER-PERCAKAPAN (-1..1) yang dihitung sama persis dengan dial di panel
-- konteks chat. Daftar percakapan membaca kolom ini agar titik/tulisan mood di kiri
-- SAMA dengan dial di kanan — tanpa harus klik dulu. Diperbarui tiap kali insight
-- dihitung & saat sentimen pesan baru masuk.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS mood_score NUMERIC(4,3);
-- Apakah percakapan pernah ditutup lalu dibuka kembali oleh agen (utk audit ringan).
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS reopened_at TIMESTAMPTZ;

-- Pesan (sumber kebenaran riwayat chat, anti hilang saat HP rusak)
CREATE TABLE IF NOT EXISTS messages (
  id              BIGSERIAL PRIMARY KEY,
  conversation_id INT REFERENCES conversations(id),
  account_id      INT REFERENCES wa_accounts(id),
  wa_message_id   VARCHAR(120),               -- id pesan dari WhatsApp (anti duplikat)
  direction       VARCHAR(8) NOT NULL,        -- 'in' | 'out'
  sender_type     VARCHAR(12) NOT NULL,       -- 'customer' | 'ai' | 'agent'
  agent_id        INT REFERENCES agents(id),  -- jika dikirim agent
  body            TEXT,
  media_type      VARCHAR(40),                -- 'image','document', dll (null jika teks)
  media_url       TEXT,
  sentiment       NUMERIC(4,3),               -- skor sentimen pesan customer
  created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wa_message
  ON messages(account_id, wa_message_id) WHERE wa_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id);

-- Waktu ASLI pesan dari WhatsApp (epoch detik dari device pengirim).
-- Dipakai untuk MENGURUTKAN transkrip sesuai kejadian nyata, bukan urutan insert DB.
-- Saat sinkronisasi riwayat, webhook bisa masuk paralel/acak sehingga m.id (urutan
-- insert) TIDAK mencerminkan kronologi. Kolom ini memperbaikinya.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS wa_timestamp TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_msg_conv_ts
  ON messages(conversation_id, wa_timestamp);

-- Penilaian kualitas komunikasi karyawan (oleh AI), per percakapan
CREATE TABLE IF NOT EXISTS agent_evaluations (
  id              SERIAL PRIMARY KEY,
  conversation_id INT REFERENCES conversations(id),
  agent_id        INT REFERENCES agents(id),
  score_politeness  INT,   -- 1..5 kesopanan
  score_clarity     INT,   -- 1..5 kejelasan
  score_helpfulness INT,   -- 1..5 solutif
  score_speed       INT,   -- 1..5 kecepatan
  summary           TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- =====================  MODUL TIKET  =====================

-- Armada / unit bus
CREATE TABLE IF NOT EXISTS buses (
  id           SERIAL PRIMARY KEY,
  code         VARCHAR(40) UNIQUE NOT NULL,  -- mis. 'B-7501-AK'
  name         VARCHAR(120),                 -- 'Scania K410 Executive'
  bus_class    VARCHAR(40),                  -- 'Ekonomi'|'Bisnis'|'Executive'|'Sleeper'
  total_seats  INT NOT NULL DEFAULT 40,
  usage_type   VARCHAR(16) DEFAULT 'both',   -- 'akap'|'pariwisata'|'both'
  active       BOOLEAN DEFAULT true,
  created_at   TIMESTAMPTZ DEFAULT now()
);

-- ---------- AKAP: rute & jadwal ----------
CREATE TABLE IF NOT EXISTS routes (
  id           SERIAL PRIMARY KEY,
  origin       VARCHAR(120) NOT NULL,
  destination  VARCHAR(120) NOT NULL,
  distance_km  INT,
  base_price   NUMERIC(12,2) NOT NULL,       -- harga dasar per kursi
  active       BOOLEAN DEFAULT true,
  created_at   TIMESTAMPTZ DEFAULT now()
);

-- Jadwal keberangkatan AKAP (1 keberangkatan = 1 bus pada tanggal/jam tertentu)
CREATE TABLE IF NOT EXISTS schedules (
  id              SERIAL PRIMARY KEY,
  route_id        INT REFERENCES routes(id),
  bus_id          INT REFERENCES buses(id),
  departure_date  DATE NOT NULL,
  departure_time  TIME NOT NULL,
  price           NUMERIC(12,2) NOT NULL,    -- harga final (boleh beda dari base saat ramai)
  status          VARCHAR(16) DEFAULT 'open',-- 'open'|'closed'|'departed'|'cancelled'
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE (route_id, bus_id, departure_date, departure_time)
);
CREATE INDEX IF NOT EXISTS idx_sched_date ON schedules(departure_date);

-- ---------- PARIWISATA: paket carter ----------
CREATE TABLE IF NOT EXISTS charter_packages (
  id              SERIAL PRIMARY KEY,
  name            VARCHAR(160) NOT NULL,     -- 'Carter Harian Dalam Kota'
  bus_class       VARCHAR(40),               -- kelas bus
  price_per_day   NUMERIC(12,2) NOT NULL,    -- harga borongan per hari
  capacity        INT,                        -- kapasitas penumpang
  includes        TEXT,                       -- 'BBM, sopir, tol' dll
  active          BOOLEAN DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- ---------- Pesanan (AKAP & Pariwisata) ----------
CREATE TABLE IF NOT EXISTS bookings (
  id              SERIAL PRIMARY KEY,
  code            VARCHAR(20) UNIQUE NOT NULL,  -- kode booking, mis. 'BUS-AB12CD'
  service_type    VARCHAR(16) NOT NULL,         -- 'akap' | 'pariwisata'
  conversation_id INT REFERENCES conversations(id),
  customer_id     INT REFERENCES customers(id),
  agent_id        INT REFERENCES agents(id),

  -- AKAP
  schedule_id     INT REFERENCES schedules(id),
  seat_numbers    INT[],                        -- kursi yang dipesan, mis. {3,4}

  -- Pariwisata
  charter_id      INT REFERENCES charter_packages(id),
  start_date      DATE,
  days            INT,
  destination     VARCHAR(200),

  pax             INT,                          -- jumlah penumpang
  amount          NUMERIC(12,2) NOT NULL DEFAULT 0,
  status          VARCHAR(20) DEFAULT 'pending',-- 'pending'|'confirmed'|'paid'|'cancelled'
  note            TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_booking_cust ON bookings(customer_id);

-- Kursi yang sudah dipesan per jadwal (untuk cek ketersediaan, anti double-booking)
CREATE TABLE IF NOT EXISTS seat_bookings (
  id           SERIAL PRIMARY KEY,
  schedule_id  INT REFERENCES schedules(id),
  seat_number  INT NOT NULL,
  booking_id   INT REFERENCES bookings(id),
  UNIQUE (schedule_id, seat_number)             -- 1 kursi 1 jadwal tak bisa dobel
);

-- Knowledge base sederhana untuk AI (FAQ, jadwal, harga)
CREATE TABLE IF NOT EXISTS knowledge (
  id          SERIAL PRIMARY KEY,
  category    VARCHAR(24),   -- 'akap' | 'pariwisata' | 'umum'
  question    TEXT,
  answer      TEXT,
  active      BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- Balasan cepat (template) untuk live chat karyawan
CREATE TABLE IF NOT EXISTS quick_replies (
  id          SERIAL PRIMARY KEY,
  title       VARCHAR(120) NOT NULL,
  body        TEXT NOT NULL,
  created_by  INT REFERENCES agents(id),
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- =====================================================================
-- Migrasi aman untuk database yang sudah ada (kolom baru siklus sesi).
-- ADD COLUMN IF NOT EXISTS = tidak error bila kolom sudah ada.
-- =====================================================================
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_sender VARCHAR(12) DEFAULT 'customer';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS followups_sent INT DEFAULT 0;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_followup_at TIMESTAMPTZ;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS close_reason VARCHAR(24);
-- bahasa terdeteksi customer (untuk balasan AI multi-bahasa), mis. 'id','en','jv'
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS lang VARCHAR(8);

-- presence agen (untuk eskalasi pintar / auto-assign)
ALTER TABLE agents ADD COLUMN IF NOT EXISTS online BOOLEAN DEFAULT false;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ;

-- pengingat keberangkatan H-1 (agar tidak dikirim dobel)
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reminded_at TIMESTAMPTZ;

-- ====================  FITUR BARU (v4)  ====================
-- Tag/label percakapan (mis. 'komplain','vip','follow_up_besok') untuk filter.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}';

-- CSAT: rating kepuasan 1-5 dari customer setelah sesi ditutup.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS csat_score INT;        -- 1..5
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS csat_at TIMESTAMPTZ;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS csat_token VARCHAR(64); -- token rahasia utk link rating

-- Catatan: kolom pembacaan bukti transfer (proof_*) untuk tabel `payments` dan
-- kolom `scheduled_at` untuk `broadcasts` kini didefinisikan langsung di dalam
-- CREATE TABLE masing-masing (lihat di bawah), agar tidak bergantung pada urutan
-- eksekusi saat database dibuat dari nol.

-- Riwayat perubahan booking (reschedule / cancel) untuk audit.
CREATE TABLE IF NOT EXISTS booking_changes (
  id            SERIAL PRIMARY KEY,
  booking_id    INT REFERENCES bookings(id) ON DELETE CASCADE,
  change_type   VARCHAR(20) NOT NULL,         -- 'reschedule' | 'cancel'
  old_value     JSONB,                        -- snapshot sebelum
  new_value     JSONB,                        -- snapshot sesudah
  refund_amount NUMERIC(12,2) DEFAULT 0,      -- nilai refund (cancel)
  fee_amount    NUMERIC(12,2) DEFAULT 0,      -- biaya (reschedule/cancel)
  reason        TEXT,
  actor         VARCHAR(16) DEFAULT 'agent',  -- 'agent' | 'ai' | 'customer'
  agent_id      INT REFERENCES agents(id),
  created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bchg_booking ON booking_changes(booking_id);

-- Status baru utk bookings: tambah 'rescheduled' & 'cancelled' sudah ada di komentar.
-- (kolom status sudah VARCHAR, tidak perlu ALTER untuk nilai baru)


-- ====================  PEMBAYARAN  ====================
-- Satu tagihan per booking. Mendukung QRIS statis / transfer manual + verifikasi.
CREATE TABLE IF NOT EXISTS payments (
  id            SERIAL PRIMARY KEY,
  booking_id    INT REFERENCES bookings(id) ON DELETE CASCADE,
  amount        NUMERIC(12,2) NOT NULL,
  method        VARCHAR(24) DEFAULT 'qris',   -- 'qris' | 'transfer' | 'cash'
  status        VARCHAR(20) DEFAULT 'unpaid', -- 'unpaid' | 'pending_verify' | 'paid' | 'expired' | 'cancelled'
  reference     VARCHAR(64) UNIQUE,           -- kode unik tagihan, mis. 'PAY-AB12CD'
  pay_url       TEXT,                         -- link bayar yang dibagikan ke customer
  proof_url     TEXT,                         -- bukti transfer (bila upload manual)
  paid_at       TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT now(),
  -- Hasil pembacaan AI atas bukti transfer (gambar) -> bantu verifikasi staf.
  proof_amount  NUMERIC(12,2),               -- nominal terbaca
  proof_bank    VARCHAR(80),                 -- bank pengirim terbaca
  proof_time    VARCHAR(60),                 -- waktu transaksi terbaca
  proof_match   VARCHAR(16),                 -- 'match'|'mismatch'|'unclear'
  proof_note    TEXT                          -- ringkasan AI
);
CREATE INDEX IF NOT EXISTS idx_pay_booking ON payments(booking_id);

-- ====================  BROADCAST  ====================
-- Kampanye pesan keluar (promo, info) dengan rate-limit agar nomor aman.
CREATE TABLE IF NOT EXISTS broadcasts (
  id            SERIAL PRIMARY KEY,
  session       VARCHAR(64) NOT NULL,         -- kirim lewat nomor mana ('cs'|'tiket')
  title         VARCHAR(160),
  body          TEXT NOT NULL,
  status        VARCHAR(20) DEFAULT 'draft',  -- 'draft'|'running'|'paused'|'done'|'cancelled'
  total         INT DEFAULT 0,
  sent          INT DEFAULT 0,
  failed        INT DEFAULT 0,
  created_by    INT REFERENCES agents(id),
  created_at    TIMESTAMPTZ DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  scheduled_at  TIMESTAMPTZ                    -- waktu kirim terjadwal (NULL = manual/segera)
);
-- Target per broadcast (1 baris per penerima). Worker memproses bertahap.
CREATE TABLE IF NOT EXISTS broadcast_targets (
  id            SERIAL PRIMARY KEY,
  broadcast_id  INT REFERENCES broadcasts(id) ON DELETE CASCADE,
  customer_id   INT REFERENCES customers(id),
  wa_id         VARCHAR(64) NOT NULL,
  status        VARCHAR(16) DEFAULT 'queued', -- 'queued'|'sent'|'failed'|'skipped'
  error         TEXT,
  sent_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_bt_bc ON broadcast_targets(broadcast_id, status);

-- ====================  PENGATURAN  ====================
-- Penyimpanan key-value sederhana untuk jam kerja, SLA, info pembayaran, dll.
CREATE TABLE IF NOT EXISTS settings (
  key         VARCHAR(64) PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- Akun admin default (password: admin123 -> diisi via seed di backend)
