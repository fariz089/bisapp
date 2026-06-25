// =====================================================================
// Eskalasi pintar: pilih agen ONLINE dengan beban paling sedikit.
// Presence agen di-update via socket (lihat server.js: 'agent:online'/disconnect)
// dan via heartbeat. last_seen dipakai sebagai cadangan bila socket putus.
// =====================================================================
import { query } from '../db/index.js';

const ONLINE_GRACE_SEC = Number(process.env.AGENT_ONLINE_GRACE_SEC || 90);

// Tandai agen online + perbarui last_seen
export async function setAgentOnline(agentId, online) {
  await query(
    'UPDATE agents SET online=$2, last_seen=now() WHERE id=$1', [agentId, !!online]);
}
export async function heartbeat(agentId) {
  await query('UPDATE agents SET last_seen=now(), online=true WHERE id=$1', [agentId]);
}

// Pilih agen untuk handover: online & last_seen segar, beban (percakapan terbuka) tersedikit.
// Bila tidak ada yang online, kembalikan null (percakapan tetap di antrian 'pending').
export async function pickAgentForHandover() {
  const { rows } = await query(
    `SELECT ag.id, ag.name,
            COUNT(c.id) FILTER (
              WHERE c.assigned_agent=ag.id AND c.status<>'resolved'
            ) AS beban
       FROM agents ag
      WHERE ag.role='agent' AND ag.active=true
        AND ag.online=true
        AND ag.last_seen IS NOT NULL
        AND ag.last_seen > now() - make_interval(secs => $1)
      GROUP BY ag.id, ag.name
      ORDER BY beban ASC, ag.last_seen DESC
      LIMIT 1`, [ONLINE_GRACE_SEC]);
  return rows[0] || null;
}

// Bersihkan presence basi (dipanggil scheduler): agen yang lama tak terlihat -> offline.
export async function reapStalePresence() {
  await query(
    `UPDATE agents SET online=false
      WHERE online=true AND (last_seen IS NULL OR last_seen < now() - make_interval(secs => $1))`,
    [ONLINE_GRACE_SEC]);
}
