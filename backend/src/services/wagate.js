// Klien untuk mengirim perintah ke container WA (whatsapp-web.js).
// Setiap sesi punya URL sendiri, dipetakan dari env WA_ENDPOINTS.
// Format env: WA_ENDPOINTS=cs=http://wa-cs:3001,tiket=http://wa-tiket:3001

const map = {};
(process.env.WA_ENDPOINTS || '').split(',').forEach(pair => {
  const [session, url] = pair.split('=');
  if (session && url) map[session.trim()] = url.trim();
});

export function endpointFor(session) {
  return map[session];
}

export async function sendMessage(session, waId, text) {
  const url = map[session];
  if (!url) throw new Error(`Endpoint WA untuk sesi '${session}' tidak ada`);
  const res = await fetch(`${url}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: waId, text }),
  });
  if (!res.ok) throw new Error(`Gagal kirim WA: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function getQr(session) {
  const url = map[session];
  if (!url) throw new Error('sesi tidak ada');
  const res = await fetch(`${url}/qr`);
  return res.json();
}

// Picu sinkronisasi riwayat di WA service untuk sebuah sesi.
// WA service mengembalikan 409 bila belum siap / sedang sync — kita teruskan
// status itu apa adanya agar route backend bisa membalas pesan yang sesuai.
export async function triggerSync(session) {
  const url = map[session];
  if (!url) throw new Error(`Endpoint WA untuk sesi '${session}' tidak ada`);
  const res = await fetch(`${url}/sync`, { method: 'POST' });
  let body = {};
  try { body = await res.json(); } catch {}
  return { status: res.status, ok: res.ok, body };
}
