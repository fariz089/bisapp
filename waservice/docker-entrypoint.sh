#!/bin/sh
set -e

# Bersihkan lock file Chromium yang basi dari proses sebelumnya.
# Lock ini valid hanya jika proses Chrome lama masih hidup — tapi karena
# container ini baru start, proses lama sudah pasti mati. Aman dihapus.
if [ -d "/app/.wwebjs_auth" ]; then
  find /app/.wwebjs_auth \
    \( -name "SingletonLock" -o -name "SingletonCookie" -o -name "SingletonSocket" \) \
    -exec rm -f {} + 2>/dev/null || true
fi

exec "$@"