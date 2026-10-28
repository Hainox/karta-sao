#!/usr/bin/env bash
# Копия зашифрованных резервных копий САО вне сервера — на Google Drive (через rclone).
#   bash sao-offsite.sh setup | run [--no-media] | install | status
set -euo pipefail
SRC=/opt/sao-recovery/server-backups
REMOTE=gdrive:SAO-backups
KEEP_DB=30
KEEP_MEDIA=1
LOG=/var/log/sao-offsite.log

latest() { find $SRC -maxdepth 2 -type f -name '*.age' -path "*-$1/*" -printf '%T@ %p\n' | sort -n | tail -1 | cut -d' ' -f2-; }

upload() {
  local f; f=$(latest "$1")
  [ -n "$f" ] || { echo "Нет локальной копии типа $1"; return 1; }
  local dir; dir=$(basename "$(dirname "$f")")
  echo "$(date -Is) $1: $dir/$(basename "$f") ($(du -h "$f" | cut -f1))"
  if rclone lsf "$REMOTE/$1/$dir/" 2>/dev/null | grep -qx "$(basename "$f")"; then
    echo "  уже на Drive"
  else
    rclone copy "$(dirname "$f")" "$REMOTE/$1/$dir" --include '*.age' --include 'result.json' --include '*.sha256' --retries 5 --low-level-retries 20
  fi
  rclone check "$(dirname "$f")" "$REMOTE/$1/$dir" --include '*.age' --one-way
  echo "  проверено: совпадает"
  rclone lsf --dirs-only "$REMOTE/$1/" | sort | head -n -"$2" | while read -r old; do
    echo "  удаляю старую копию на Drive: $old"; rclone purge "$REMOTE/$1/$old"; done
}

case "${1:-status}" in
  setup)
    command -v rclone >/dev/null || apt-get install -y rclone
    echo "Вставьте строку-токен (начинается с {\"access_token\") и нажмите Enter:"
    read -r TOKEN
    rclone config create gdrive drive scope drive.file token "$TOKEN" >/dev/null
    rclone mkdir "$REMOTE"
    rclone about gdrive: || true
    echo "Google Drive подключён. Папка на Drive: SAO-backups" ;;
  run)
    { upload database $KEEP_DB; if [ "${2:-}" != "--no-media" ]; then upload media $KEEP_MEDIA || echo "ВНИМАНИЕ: копия фото не отправлена"; fi; echo "$(date -Is) ГОТОВО"; } 2>&1 | tee -a $LOG ;;
  install)
    install -m 0755 "$0" /usr/local/bin/sao-offsite.sh
    printf '[Unit]\nDescription=SAO offsite copy to Google Drive\nAfter=network-online.target\n[Service]\nType=oneshot\nExecStart=/usr/local/bin/sao-offsite.sh run\n' > /etc/systemd/system/sao-offsite.service
    printf '[Unit]\nDescription=Daily SAO offsite copy\n[Timer]\nOnCalendar=*-*-* 04:40:00 UTC\nPersistent=true\n[Install]\nWantedBy=timers.target\n' > /etc/systemd/system/sao-offsite.timer
    systemctl daemon-reload && systemctl enable --now sao-offsite.timer
    systemctl list-timers sao-offsite.timer --no-pager ;;
  status)
    rclone about gdrive: 2>/dev/null || echo "Google Drive ещё не подключён"
    rclone lsl "$REMOTE" 2>/dev/null | tail -10 || true
    systemctl list-timers sao-offsite.timer --no-pager 2>/dev/null || true
    tail -5 $LOG 2>/dev/null || true ;;
  *) echo "Использование: bash sao-offsite.sh setup|run [--no-media]|install|status"; exit 2 ;;
esac
