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
