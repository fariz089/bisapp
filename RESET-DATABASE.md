# Cara Reset Database (tanpa akses DB dari luar)

Semua langkah dijalankan di **server** lewat SSH — di folder tempat ada
`docker-compose.yml`. Tidak perlu buka port database atau psql dari luar.

> ⚠️ PERINGATAN: ini menghapus SELURUH data — percakapan, booking, tiket,
> pembayaran, KPI, broadcast. Tidak bisa dibatalkan. Pastikan tidak ada data
> produksi yang penting.

> ⚠️ PENTING soal harapan: reset TIDAK memunculkan nomor asli untuk chat `@lid`.
> Nomor itu memang tidak tersedia dari WhatsApp. Setelah reset + kode baru,
> chat `@lid` akan tampil **"Nomor tak diketahui"** (bukan `+144...` palsu).
> Chat dari nomor biasa (@c.us) akan tampil nomor yang benar.

---

## PERSIAPAN: pastikan kode baru benar-benar ter-build

Reset percuma kalau yang jalan masih kode lama. Pastikan dulu:

```bash
cd /path/ke/bisapp        # folder yang ada docker-compose.yml

# 1) Ganti seluruh isi folder dengan isi zip perbaikan terbaru
#    (timpa file lama). Lalu rebuild TANPA cache supaya pasti pakai kode baru:
docker compose build --no-cache
docker compose up -d
```

Verifikasi kode baru sudah jalan (cari endpoint baru di dalam container backend):
```bash
docker compose exec backend grep -c "clean-phones" src/server.js
# harus keluar angka >= 1. Kalau 0, berarti file belum ter-update — ulangi copy.
```

---

## OPSI A — Reset DATABASE saja (DISARANKAN)

Tidak perlu scan QR ulang. WA service otomatis sinkron ulang riwayat.

```bash
cd /path/ke/bisapp

# 1) Matikan semua container
docker compose down

# 2) Hapus HANYA volume database (riwayat WhatsApp tetap, tak perlu scan QR)
docker volume rm bisapp_db_data
#   Kalau nama volume beda, lihat dengan: docker volume ls | grep db_data
#   (prefix biasanya = nama folder project, mis. 'bisapp_db_data')

# 3) Nyalakan lagi — schema dibuat ulang dari nol, admin & seed otomatis dibuat
docker compose up -d

# 4) Pantau backend sampai "Inisialisasi selesai." lalu WA mulai sinkron
docker compose logs -f backend
```

Setelah hidup, WA service akan otomatis menarik ulang riwayat chat ke DB kosong
(karena `SYNC_HISTORY=true`), kini DENGAN logika nomor yang sudah diperbaiki.

---

## OPSI B — Reset TOTAL (database + sesi WhatsApp)

Benar-benar bersih, TAPI harus scan QR ulang 2 nomor.

```bash
cd /path/ke/bisapp
docker compose down

# Hapus database + kedua sesi WhatsApp + media
docker volume rm bisapp_db_data bisapp_wa_cs_auth bisapp_wa_tiket_auth bisapp_media_data
#   (sesuaikan prefix bila perlu: docker volume ls)

docker compose up -d
docker compose logs -f backend
```

Lalu buka aplikasi → menu **Koneksi** → scan QR untuk nomor CS dan Tiket.

---

## SETELAH RESET: tidak perlu langkah pembersih lagi

Karena database mulai dari nol, semua pesan/customer baru langsung memakai logika
yang sudah diperbaiki:
- Nomor `@lid` → "Nomor tak diketahui" (bukan nomor palsu)
- Nomor biasa → tampil benar
- Sentimen tidak terkunci 0 saat 429
- Skor mood pakai formula baru (komplain = negatif, bukan netral)

---

## KALAU TIDAK MAU RESET (alternatif tanpa hapus data apa pun)

Cukup login sebagai admin, lalu panggil 2 endpoint pembersih SEKALI. Bisa lewat
Console browser (F12) saat sudah login di aplikasi — token diambil otomatis dari
localStorage:

```js
// Tempel di Console browser saat sedang login di crm-mu:
(async () => {
  const t = localStorage.getItem('token');               // token login
  const h = { 'Content-Type':'application/json', 'Authorization':'Bearer '+t };
  const a = await (await fetch('/api/customers/clean-phones', {method:'POST', headers:h})).json();
  const b = await (await fetch('/api/insights/reset-neutral', {method:'POST', headers:h})).json();
  console.log('clean-phones:', a);
  console.log('reset-neutral:', b);
})();
```

- `clean-phones` → NULL-kan nomor palsu dari `@lid` (jadi "Nomor tak diketahui")
- `reset-neutral` → NULL-kan sentimen 0 palsu agar dinilai ulang (mood jadi benar)

> Catatan: nama key token mungkin bukan persis `'token'`. Cek dulu di Console:
> `Object.keys(localStorage)` — cari yang berisi JWT, lalu sesuaikan.
