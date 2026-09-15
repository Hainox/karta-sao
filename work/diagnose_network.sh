#!/bin/sh
# Проверяет, каким маршрутом сервер достаёт Telegram и обычные сайты.

echo "=== обычные сайты ==="
for host in https://example.com https://github.com https://hainox.github.io; do
  printf '%-28s ' "$host"
  curl -s -o /dev/null -w '%{http_code}\n' --max-time 12 "$host"
done

echo
echo "=== Telegram по IPv4-адресам ==="
for ip in 149.154.166.110 149.154.167.220 149.154.167.197 149.154.175.50; do
  printf '%-18s ' "$ip"
  curl -s -o /dev/null -w '%{http_code}\n' --max-time 10 --resolve "api.telegram.org:443:$ip" https://api.telegram.org/
done

echo
echo "=== Telegram по IPv6 ==="
curl -s -o /dev/null -w 'IPv6: %{http_code}\n' --max-time 10 "https://[2001:67c:4e8:f004::9]/"

echo
echo "=== есть ли прокси в окружении ==="
env | grep -i proxy || echo "переменных прокси нет"
