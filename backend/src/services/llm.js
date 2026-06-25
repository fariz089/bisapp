// =====================================================================
// Service LLM — kompatibel OpenAI (/v1/chat/completions)
// Dipakai untuk: AI agent CS, analisis sentimen, evaluasi karyawan,
// dan perangkuman profil/perilaku customer.
// Konfigurasi via env: LLM_BASE_URL, LLM_API_KEY, LLM_MODEL
// =====================================================================

const BASE_URL = process.env.LLM_BASE_URL || 'https://api.openai.com/v1';
const API_KEY = process.env.LLM_API_KEY || '';
const MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';

async function chat(messages, { temperature = 0.4, maxTokens = 600, json = false } = {}) {
  const body = {
    model: MODEL,
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  if (json) body.response_format = { type: 'json_object' };

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`LLM error ${res.status}: ${txt}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() ?? '';
}

// --- Persona AI agent untuk usaha bis ---
function systemPrompt(knowledge, accountLabel, ticketCtx, opts = {}) {
  const { lang, afterHours, afterHoursMessage } = opts;
  const kb = knowledge && knowledge.length
    ? knowledge.map(k => `- [${k.category}] ${k.question}\n  Jawab: ${k.answer}`).join('\n')
    : '(belum ada data knowledge base)';

  let jadwal = '(belum ada jadwal AKAP)';
  let carter = '(belum ada paket pariwisata)';
  if (ticketCtx) {
    if (ticketCtx.schedules?.length) {
      jadwal = ticketCtx.schedules.map(s =>
        `- [jadwal_id=${s.id}] ${s.origin} → ${s.destination}, ${s.departure_date} ${String(s.departure_time).slice(0,5)}, kelas ${s.bus_class}, Rp${Number(s.price).toLocaleString('id-ID')}/kursi, sisa ${s.avail} kursi`
      ).join('\n');
    }
    if (ticketCtx.charters?.length) {
      carter = ticketCtx.charters.map(c =>
        `- [paket_id=${c.id}] ${c.name} (${c.bus_class}), Rp${Number(c.price_per_day).toLocaleString('id-ID')}/hari, kapasitas ${c.capacity}, termasuk: ${c.includes || '-'}`
      ).join('\n');
    }
  }

  const langLine = lang && lang !== 'id'
    ? `\nBAHASA: Customer menulis dalam bahasa "${lang}". Balas dalam bahasa yang SAMA dengan customer.`
    : '\nBAHASA: Balas dalam Bahasa Indonesia yang sopan & ramah.';

  const hoursLine = afterHours
    ? `\nDI LUAR JAM KERJA: Saat ini di luar jam operasional staf. Anda TETAP boleh membantu info jadwal/harga & membuat draft booking, tetapi untuk hal yang butuh staf manusia, sampaikan dengan sopan bahwa staf akan menindaklanjuti pada jam kerja. Jangan menjanjikan respons manusia instan.`
    : '';

  return `Anda adalah AI Customer Service untuk perusahaan otobus yang melayani:
1. AKAP (Antar Kota Antar Provinsi): bus dengan trayek & jadwal tetap, tiket per kursi.
2. PARIWISATA: bus carter/sewa untuk rombongan, harga borongan, tanpa trayek tetap.

Kanal ini: "${accountLabel}".
${langLine}${hoursLine}

ATURAN UMUM:
- Sopan, ramah, ringkas. Jangan mengarang harga/jadwal yang tidak ada di data.
- Untuk AKAP tanyakan: rute asal-tujuan, tanggal, jumlah penumpang.
- Untuk PARIWISATA tanyakan: tujuan/acara, tanggal, lama sewa, jumlah orang.
- Gunakan knowledge base bila relevan.

KEMAMPUAN AKSI (PENTING):
Anda BISA membuat draft pemesanan sendiri (status "pending") tanpa menunggu staf, lalu staf/Anda
mengirim instruksi pembayaran. Untuk melakukan aksi, sisipkan SATU baris token JSON di AKHIR balasan,
PERSIS dengan format berikut (di baris sendiri, tanpa tambahan apa pun setelahnya):

  [[ACTION:{"tool":"cek_jadwal","origin":"Jakarta","destination":"Surabaya","date":"2025-07-01"}]]
  atau
  [[ACTION:{"tool":"buat_booking_akap","jadwal_id":1,"jumlah_kursi":2,"nama":"Budi"}]]
  atau
  [[ACTION:{"tool":"buat_booking_pariwisata","paket_id":2,"tanggal":"2025-07-10","hari":2,"tujuan":"Bromo","jumlah_orang":30,"nama":"Sinta"}]]
  atau
  [[ACTION:{"tool":"minta_pembayaran","booking_kode":"AKAP-XXXX"}]]

ATURAN AKSI:
- Pakai jadwal_id / paket_id dari daftar di bawah (angka di dalam kurung siku). JANGAN menebak id.
- Buat booking HANYA setelah detail jelas (jadwal/paket + tanggal + jumlah) dan customer setuju.
- Untuk AKAP via aksi, sistem otomatis memilihkan kursi yang masih kosong sejumlah yang diminta.
- Setelah booking dibuat, sistem akan memberi tahu Anda kodenya; baru kirim "minta_pembayaran".
- Untuk komplain/refund/sengketa, atau bila customer minta manusia, jangan pakai aksi —
  akhiri balasan dengan token: [[HANDOVER]]
- Tampilkan token [[ACTION:...]] atau [[HANDOVER]] HANYA di akhir, tidak di tengah kalimat.
- Tulis balasan natural untuk customer SEBELUM token. Customer tidak melihat token.

JADWAL AKAP TERSEDIA:
${jadwal}

PAKET PARIWISATA / CARTER TERSEDIA:
${carter}

KNOWLEDGE BASE TAMBAHAN:
${kb}`;
}

// Susun riwayat untuk konteks (maks N pesan terakhir)
function buildHistory(history) {
  return history.map(m => ({
    role: m.sender_type === 'customer' ? 'user' : 'assistant',
    content: m.body || '',
  }));
}

// AI menjawab pesan customer.
// Mengembalikan { reply, handover, action } di mana action (opsional) adalah
// objek hasil parse token [[ACTION:{...}]] untuk dieksekusi oleh backend.
export async function aiReply({ knowledge, accountLabel, history, userText, ticketCtx, lang, afterHours }) {
  const messages = [
    { role: 'system', content: systemPrompt(knowledge, accountLabel, ticketCtx, { lang, afterHours }) },
    ...buildHistory(history).slice(-12),
    { role: 'user', content: userText },
  ];
  const raw = await chat(messages, { temperature: 0.4, maxTokens: 600 });

  const handover = raw.includes('[[HANDOVER]]');

  // Ekstrak token aksi bila ada: [[ACTION:{...json...}]]
  let action = null;
  let cleaned = raw;
  const m = raw.match(/\[\[ACTION:(\{[\s\S]*?\})\]\]/);
  if (m) {
    try { action = JSON.parse(m[1]); }
    catch { action = null; } // JSON rusak -> abaikan aksi, tetap kirim teksnya
    cleaned = raw.replace(m[0], '');
  }
  const reply = cleaned.replace('[[HANDOVER]]', '').trim();
  return { reply, handover, action };
}

// Pesan singkat untuk dikirim AI setelah sebuah aksi berhasil/gagal,
// agar tetap natural (mis. konfirmasi booking). Tanpa token apa pun.
export async function aiFollowupAfterAction({ accountLabel, history, systemNote, lang }) {
  const langLine = lang && lang !== 'id'
    ? `Balas dalam bahasa "${lang}".` : 'Balas dalam Bahasa Indonesia.';
  const messages = [
    { role: 'system', content:
      `Anda CS bus "${accountLabel}". ${langLine} Sampaikan info berikut ke customer dengan ramah & ringkas ` +
      `(maks 3 kalimat), tanpa token khusus apa pun:\n${systemNote}` },
    ...buildHistory(history).slice(-6),
  ];
  return (await chat(messages, { temperature: 0.4, maxTokens: 220 })).replace(/\[\[.*?\]\]/g, '').trim();
}

// Deteksi bahasa pesan customer -> kode ISO pendek ('id','en','jv','su', dst).
export async function detectLanguage(text) {
  if (!text || text.trim().length < 3) return 'id';
  try {
    const out = await chat(
      [
        { role: 'system', content:
          'Deteksi bahasa teks. Balas HANYA JSON: {"lang":"<kode ISO 639-1 2 huruf, atau \'jv\' Jawa, \'su\' Sunda>"}.' },
        { role: 'user', content: text.slice(0, 400) },
      ],
      { temperature: 0, maxTokens: 20, json: true }
    );
    const j = JSON.parse(out);
    const code = String(j.lang || 'id').toLowerCase().slice(0, 2);
    return /^[a-z]{2}$/.test(code) ? code : 'id';
  } catch {
    return 'id';
  }
}

// Analisis sentimen 1 pesan customer -> skor -1..1
export async function analyzeSentiment(text) {
  try {
    const out = await chat(
      [
        { role: 'system', content:
          'Anda menilai NADA EMOSI pesan customer layanan pelanggan (Bahasa Indonesia, termasuk bahasa gaul/singkatan). ' +
          'Beri skor pada skala -1.0 sampai 1.0 dengan makna:\n' +
          '  -1.0 s/d -0.6 = sangat negatif (marah, kecewa berat, mengancam, mengumpat)\n' +
          '  -0.5 s/d -0.2 = negatif (kesal, tidak sabar, mengeluh, menuntut, ragu/curiga)\n' +
          '  -0.1 s/d 0.1  = netral murni (pertanyaan/info datar tanpa emosi, mis. "berapa harganya")\n' +
          '   0.2 s/d 0.5  = positif (antusias, tertarik, kooperatif, berterima kasih ringan)\n' +
          '   0.6 s/d 1.0  = sangat positif (senang sekali, memuji, sangat puas)\n' +
          'PENTING: jangan asal memberi 0. Tangkap sinyal halus: "gimana kak?" berulang = tidak sabar (negatif ringan); ' +
          '"oke siap kak makasih" = positif; "kok lama ya" / "katanya tadi" = kesal; "wah keren" / "mantap" = positif. ' +
          'Pertimbangkan tanda seru, huruf kapital, emoji, dan pengulangan. ' +
          'Balas HANYA JSON: {"score": <angka -1..1, boleh desimal>, "label":"positif|netral|negatif", "kesan":"<2-4 kata kesan customer, mis. \'tidak sabar\', \'antusias\', \'kecewa\', \'santai/kooperatif\'>"}.' },
        { role: 'user', content: text },
      ],
      { temperature: 0, maxTokens: 80, json: true }
    );
    const j = JSON.parse(out);
    // Jangan pakai "|| 0" — itu mengubah skor 0 yang valid jadi 0 dan menyembunyikan NaN.
    let score = Number(j.score);
    if (!Number.isFinite(score)) score = 0;
    score = Math.max(-1, Math.min(1, score));
    return { score, label: j.label || 'netral', kesan: j.kesan || '' };
  } catch {
    // Gagal menilai (mis. rate limit 429). Kembalikan null — JANGAN catat 0,
    // karena 0 = "netral nyata" dan akan mengunci data jadi netral selamanya.
    // Dengan null, pemanggil membiarkan sentiment tetap NULL untuk dicoba ulang.
    return null;
  }
}

// Rangkum perilaku customer dari riwayat -> tag + catatan
export async function summarizeCustomer(history) {
  try {
    const text = history.map(m => `${m.sender_type === 'customer' ? 'Customer' : 'CS'}: ${m.body}`).join('\n');
    const out = await chat(
      [
        { role: 'system', content: 'Analisis perilaku CUSTOMER dari transkrip. Balas HANYA JSON: {"behavior_tag":"ramah|mudah_marah|cerewet|to_the_point|netral","note":"<1 kalimat ringkas saran penanganan>"}.' },
        { role: 'user', content: text.slice(0, 4000) },
      ],
      { temperature: 0.2, maxTokens: 120, json: true }
    );
    const j = JSON.parse(out);
    if (!j || !j.behavior_tag) return null;
    return { behavior_tag: j.behavior_tag, note: j.note || '' };
  } catch {
    // Gagal (mis. rate limit 429 / JSON rusak): kembalikan null agar pemanggil
    // TIDAK menimpa arketipe yang sudah ada dengan 'netral' palsu.
    return null;
  }
}

// Buat satu pesan follow-up yang ramah & kontekstual saat customer diam.
// Singkat, tidak memaksa, dan mengundang customer melanjutkan / mengarah ke booking.
export async function followupMessage(history) {
  const text = history.map(m => {
    const who = m.sender_type === 'customer' ? 'Customer' : (m.sender_type === 'agent' ? 'Staf' : 'AI');
    return `${who}: ${m.body || ''}`;
  }).join('\n');
  const out = await chat(
    [
      { role: 'system', content:
        'Anda CS bus AKAP & Pariwisata. Customer berhenti membalas. Tulis SATU pesan WhatsApp ' +
        'singkat (maks 2 kalimat), ramah, Bahasa Indonesia, untuk menyenggol customer dengan sopan ' +
        'dan menawarkan bantuan lanjutan (mis. melanjutkan pemilihan jadwal/booking). Jangan memaksa, ' +
        'jangan minta maaf berlebihan, jangan menyebut Anda AI. Boleh 1 emoji. Balas HANYA teks pesannya.' },
      { role: 'user', content: text.slice(0, 2500) || '(belum ada riwayat)' },
    ],
    { temperature: 0.6, maxTokens: 90 }
  );
  return (out || '').replace(/\[\[HANDOVER\]\]/g, '').trim();
}

// Evaluasi kualitas komunikasi KARYAWAN dari transkrip percakapan
export async function evaluateAgent(history) {
  try {
    const text = history.map(m => {
      const who = m.sender_type === 'customer' ? 'Customer' : (m.sender_type === 'agent' ? 'Karyawan' : 'AI');
      return `${who}: ${m.body}`;
    }).join('\n');
    const out = await chat(
      [
        { role: 'system', content: 'Evaluasi kualitas komunikasi KARYAWAN (bukan AI) saat melayani customer. Balas HANYA JSON: {"politeness":1-5,"clarity":1-5,"helpfulness":1-5,"speed":1-5,"summary":"<1 kalimat>"}.' },
        { role: 'user', content: text.slice(0, 4000) },
      ],
      { temperature: 0.2, maxTokens: 160, json: true }
    );
    const j = JSON.parse(out);
    return {
      politeness: +j.politeness || 3,
      clarity: +j.clarity || 3,
      helpfulness: +j.helpfulness || 3,
      speed: +j.speed || 3,
      summary: j.summary || '',
    };
  } catch {
    return { politeness: 3, clarity: 3, helpfulness: 3, speed: 3, summary: '' };
  }
}

// =====================================================================
// Pembacaan bukti transfer (gambar) dengan model vision (OpenAI-compatible).
// Menerima base64 gambar + nominal/bank yang DIHARAPKAN, lalu membandingkan.
// Mengembalikan { amount, bank, time, match:'match'|'mismatch'|'unclear', note }.
// Tahan-error: bila model tak mendukung vision atau gagal, kembalikan 'unclear'.
// =====================================================================
export async function readPaymentProof({ base64, mimetype, expectAmount, expectBank }) {
  try {
    const sys =
      'Anda memverifikasi BUKTI TRANSFER bank/e-wallet dari gambar. ' +
      'Ekstrak data yang terlihat dan bandingkan dengan nominal yang diharapkan. ' +
      'Balas HANYA JSON: {"amount": <angka tanpa titik/koma, atau null>, ' +
      '"bank": "<nama bank/ewallet pengirim atau null>", ' +
      '"time": "<tanggal/jam transaksi terbaca atau null>", ' +
      '"status_terbaca": "<berhasil|pending|gagal|tidak_jelas>", ' +
      '"match": "<match|mismatch|unclear>", "note": "<1 kalimat ringkas Bahasa Indonesia>"}. ' +
      'match = nominal terbaca == nominal diharapkan DAN status berhasil. ' +
      'mismatch = nominal/berbeda jelas atau status gagal. unclear = gambar buram/bukan bukti transfer.';
    const userText =
      `Nominal diharapkan: ${expectAmount != null ? 'Rp' + Number(expectAmount).toLocaleString('id-ID') : '(tidak diketahui)'}. ` +
      `Tujuan transfer (jika terbaca harus cocok): ${expectBank || '(tidak diketahui)'}. ` +
      `Periksa gambar bukti berikut.`;

    const out = await chat(
      [
        { role: 'system', content: sys },
        {
          role: 'user',
          content: [
            { type: 'text', text: userText },
            { type: 'image_url', image_url: { url: `data:${mimetype || 'image/jpeg'};base64,${base64}` } },
          ],
        },
      ],
      { temperature: 0, maxTokens: 220, json: true }
    );
    const j = JSON.parse(out);
    const amount = j.amount == null ? null : Number(String(j.amount).replace(/[^\d]/g, '')) || null;
    let match = ['match', 'mismatch', 'unclear'].includes(j.match) ? j.match : 'unclear';
    // Pengaman: bila kita tahu nominal & terbaca, tegakkan kecocokan secara deterministik.
    if (expectAmount != null && amount != null) {
      match = Number(amount) === Number(expectAmount) ? (match === 'unclear' ? 'match' : match) : 'mismatch';
    }
    return {
      amount,
      bank: j.bank ? String(j.bank).slice(0, 80) : null,
      time: j.time ? String(j.time).slice(0, 60) : null,
      match,
      note: j.note ? String(j.note).slice(0, 300) : '',
    };
  } catch (e) {
    return { amount: null, bank: null, time: null, match: 'unclear', note: 'Tidak dapat membaca bukti otomatis: ' + (e.message || 'error') };
  }
}

// Parse angka rating 1-5 dari teks bebas customer (untuk CSAT).
// Mengembalikan integer 1..5 atau null bila tidak ada rating yang jelas.
export function parseCsatScore(text) {
  if (!text) return null;
  const t = String(text).trim();
  // Tangani bentuk "5", "5/5", "nilai 4", "⭐⭐⭐⭐", "bintang 5"
  const stars = (t.match(/⭐|★/g) || []).length;
  if (stars >= 1 && stars <= 5) return stars;
  const m = t.match(/\b([1-5])\s*(?:\/\s*5)?\b/);
  if (m) return Number(m[1]);
  return null;
}

// =====================================================================
// Kesan kualitatif customer untuk SATU percakapan (untuk panel mood).
// Membaca transkrip & menjelaskan bagaimana perasaan/kesan customer dengan
// bahasa manusia — bukan sekadar angka. Mengembalikan:
//   { headline, feeling, summary, signals[] }
//   headline = 1 frasa singkat (mis. "Tertarik tapi tidak sabar")
//   feeling  = satu kata mood dominan ('positif'|'netral'|'negatif'|'campuran')
//   summary  = 1-2 kalimat kesan + apa yang customer inginkan
//   signals  = 1-3 bukti singkat dari pesan (kutipan/parafrase pendek)
// =====================================================================
export async function conversationImpression(history) {
  try {
    const text = history.map(m => {
      const who = m.sender_type === 'customer' ? 'Customer'
        : (m.sender_type === 'agent' ? 'Staf' : 'AI');
      return `${who}: ${m.body || ''}`;
    }).filter(l => l.length > 9).join('\n').slice(0, 4000);
    if (!text.trim()) return null;

    const out = await chat(
      [
        { role: 'system', content:
          'Anda menganalisis percakapan layanan pelanggan (Bahasa Indonesia, bisa gaul/singkatan). ' +
          'Jelaskan KESAN customer secara manusiawi: bagaimana perasaannya dan apa yang dia inginkan. ' +
          'Fokus pada customer, bukan staf. Jujur — jika customer terlihat kesal/tidak sabar, katakan; ' +
          'jika datar/transaksional, katakan netral; jika senang, katakan. ' +
          'Balas HANYA JSON: {' +
          '"headline":"<3-6 kata, kesan utama, mis. \'Tidak sabar ingin cepat selesai\'>", ' +
          '"feeling":"positif|netral|negatif|campuran", ' +
          '"summary":"<1-2 kalimat: kesan customer + apa yang dia mau>", ' +
          '"signals":["<bukti singkat 1>","<bukti singkat 2>"]}' },
        { role: 'user', content: text },
      ],
      { temperature: 0.3, maxTokens: 240, json: true }
    );
    const j = JSON.parse(out);
    return {
      headline: (j.headline || '').toString().slice(0, 80),
      feeling: ['positif', 'netral', 'negatif', 'campuran'].includes(j.feeling) ? j.feeling : 'netral',
      summary: (j.summary || '').toString().slice(0, 400),
      signals: Array.isArray(j.signals) ? j.signals.slice(0, 3).map(s => String(s).slice(0, 120)) : [],
    };
  } catch {
    return null;
  }
}

