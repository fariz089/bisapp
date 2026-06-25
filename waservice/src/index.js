import express from 'express';
import qrcode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth, MessageMedia } = pkg;

// ---- Konfigurasi via env ----
const SESSION = process.env.SESSION || 'default';        // mis. 'cs' atau 'tiket'
const PORT = process.env.PORT || 3001;
const BACKEND_URL = process.env.BACKEND_URL || 'http://backend:3000';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'webhook-secret';
const SYNC_HISTORY = (process.env.SYNC_HISTORY || 'true') === 'true';
const SYNC_LIMIT = parseInt(process.env.SYNC_LIMIT || '30', 10); // pesan per chat saat sync awal
const MAX_MEDIA_MB = parseInt(process.env.MAX_MEDIA_MB || '16', 10);

// Folder media bersama (di-mount juga oleh backend untuk disajikan)
const MEDIA_DIR = process.env.MEDIA_DIR || '/app/media';
fs.mkdirSync(MEDIA_DIR, { recursive: true });

const EXT_BY_MIME = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'application/pdf': 'pdf', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3',
  'video/mp4': 'mp4', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

// Unduh media dari sebuah pesan, simpan ke disk, kembalikan {mediaType, mediaUrl, mediaName}
async function downloadMedia(msg) {
  try {
    const media = await msg.downloadMedia();
    if (!media || !media.data) return {};
    const buf = Buffer.from(media.data, 'base64');
    if (buf.length > MAX_MEDIA_MB * 1024 * 1024) {
      console.warn(`[wa:${SESSION}] media dilewati (>${MAX_MEDIA_MB}MB)`);
      return { mediaType: msg.type, mediaName: media.filename || null, oversize: true };
    }
    const ext = EXT_BY_MIME[media.mimetype] || (media.mimetype?.split('/')[1] || 'bin').split(';')[0];
    const fname = `${SESSION}-${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`;
    fs.writeFileSync(path.join(MEDIA_DIR, fname), buf);
    return {
      mediaType: msg.type,              // 'image' | 'document' | 'audio' | 'video' | 'ptt'
      mediaUrl: `/media/${fname}`,      // disajikan oleh backend
      mediaName: media.filename || null,
      mimetype: media.mimetype,
    };
  } catch (e) {
    console.error(`[wa:${SESSION}] gagal unduh media:`, e.message);
    return {};
  }
}

let lastQrDataUrl = null;
let ready = false;

const app = express();
app.use(express.json({ limit: '10mb' }));

const client = new Client({
  authStrategy: new LocalAuth({ clientId: SESSION, dataPath: '/app/.wwebjs_auth' }),
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote',
      '--disable-gpu',
    ],
  },
});

async function postWebhook(pathname, payload) {
  try {
    await fetch(`${BACKEND_URL}/api/webhook/${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-secret': WEBHOOK_SECRET },
      body: JSON.stringify({ session: SESSION, ...payload }),
    });
  } catch (e) {
    console.error(`[wa:${SESSION}] webhook ${pathname} gagal:`, e.message);
  }
}

client.on('qr', async (qr) => {
  lastQrDataUrl = await qrcode.toDataURL(qr);
  console.log(`[wa:${SESSION}] QR baru tersedia di GET /qr — scan dengan WhatsApp.`);
  await postWebhook('status', { status: 'qr' });
});

client.on('authenticated', () => console.log(`[wa:${SESSION}] terautentikasi.`));

client.on('ready', async () => {
  ready = true;
  lastQrDataUrl = null;
  const phone = client.info?.wid?.user;
  console.log(`[wa:${SESSION}] SIAP. Nomor: ${phone}`);
  await postWebhook('status', { status: 'connected', phone });

  if (SYNC_HISTORY) {
    syncOldMessages().catch(e => console.error(`[wa:${SESSION}] sync gagal:`, e.message));
  }
});

client.on('disconnected', async (reason) => {
  ready = false;
  console.log(`[wa:${SESSION}] terputus:`, reason);
  await postWebhook('status', { status: 'disconnected' });
});

// Pesan masuk realtime
client.on('message', async (msg) => {
  if (msg.from === 'status@broadcast') return;
  if (msg.fromMe) return;
  const chat = await msg.getChat().catch(() => null);
  if (chat?.isGroup) return; // abaikan grup; hapus baris ini bila ingin handle grup

  let contactName = null;
  try { const c = await msg.getContact(); contactName = c?.pushname || c?.name || null; } catch {}

  let mediaInfo = {};
  if (msg.hasMedia) mediaInfo = await downloadMedia(msg);

  await postWebhook('incoming', {
    waId: msg.from,
    name: contactName,
    body: msg.body || '',
    waMessageId: msg.id?._serialized,
    mediaType: msg.hasMedia ? (mediaInfo.mediaType || msg.type || 'media') : null,
    mediaUrl: mediaInfo.mediaUrl || null,
    mediaName: mediaInfo.mediaName || null,
  });
});

// ---- Sinkronisasi pesan lama (yang masih ada di sesi WhatsApp Web) ----
async function syncOldMessages() {
  console.log(`[wa:${SESSION}] mulai sinkronisasi riwayat (limit ${SYNC_LIMIT}/chat)...`);
  const chats = await client.getChats();
  let count = 0;
  for (const chat of chats) {
    if (chat.isGroup) continue;
    let msgs = [];
    try { msgs = await chat.fetchMessages({ limit: SYNC_LIMIT }); } catch { continue; }
    for (const m of msgs) {
      // hanya pesan masuk dari customer yang kita simpan via webhook incoming.
      // pesan keluar lama (fromMe) dikirim sebagai histori juga agar transkrip utuh.
      let mediaInfo = {};
      if (m.hasMedia) mediaInfo = await downloadMedia(m);
      await postWebhook('incoming', {
        waId: m.fromMe ? chat.id._serialized : m.from,
        name: chat.name || null,
        body: m.body || '',
        waMessageId: m.id?._serialized,
        mediaType: m.hasMedia ? (mediaInfo.mediaType || m.type || 'media') : null,
        mediaUrl: mediaInfo.mediaUrl || null,
        mediaName: mediaInfo.mediaName || null,
        historical: true,
        fromMe: m.fromMe,
      });
      count++;
    }
  }
  console.log(`[wa:${SESSION}] sinkronisasi selesai: ${count} pesan dikirim ke backend.`);
}

// ---- HTTP API untuk backend ----
app.get('/qr', (req, res) => {
  if (ready) return res.json({ ready: true, qr: null });
  res.json({ ready: false, qr: lastQrDataUrl });
});

app.get('/status', (req, res) => res.json({ session: SESSION, ready }));

app.post('/send', async (req, res) => {
  const { to, text, mediaPath, caption } = req.body;
  if (!ready) return res.status(409).json({ error: 'WA belum siap' });
  try {
    let sent;
    if (mediaPath) {
      // mediaPath relatif terhadap MEDIA_DIR, mis. 'cs-123.pdf'
      const full = path.join(MEDIA_DIR, path.basename(mediaPath));
      const media = MessageMedia.fromFilePath(full);
      sent = await client.sendMessage(to, media, { caption: caption || text || '' });
    } else {
      sent = await client.sendMessage(to, text);
    }
    res.json({ ok: true, id: sent.id?._serialized });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/sync', async (req, res) => {
  res.json({ ok: true, message: 'sinkronisasi dimulai' });
  syncOldMessages().catch(() => {});
});

app.listen(PORT, () => console.log(`[wa:${SESSION}] HTTP di :${PORT}`));
client.initialize();
