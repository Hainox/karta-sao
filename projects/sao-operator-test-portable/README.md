# Локальная копия оператора САО

Это изолированный тестовый стенд для страницы `/operator`. Статические ресурсы сохранены из публичной Next.js-сборки, а production API заменён на локальный mock-сервис в `server.py`.

## Запуск

```powershell
cd "C:\Users\dmitr\OneDrive\Документы\ChatGPT\КОПИЯ ТЕСТ\operator-test-copy"
python server.py
```

Открыть: <http://127.0.0.1:8765/operator>

Демо-вход:

- логин: `demo@local.test`
- пароль: `demo`

## Развёртывание на другом устройстве

### Docker — рекомендуемый вариант

```bash
docker compose up --build -d
```

После запуска открыть `http://127.0.0.1:8765/operator`. Если порт занят, задать другой перед запуском:

```bash
OPERATOR_PORT=9000 docker compose up --build -d
```

На Windows PowerShell:

```powershell
$env:OPERATOR_PORT = "9000"
docker compose up --build -d
```

### Без Docker

- Windows: двойной щелчок по `start.bat` или `.\run.ps1 -Port 8765`
- Linux/macOS: `sh ./run.sh`

Требуется только Python 3.10 или новее; внешние Python-пакеты не нужны. Для доступа с другого устройства в той же сети используйте IP компьютера, на котором запущен стенд: `http://<IP>:8765/operator`.

Файл `healthcheck.py` проверяет `/__mock__/health`; `restart: unless-stopped` перезапускает контейнер при завершении процесса, а healthcheck показывает его состояние.

## Границы стенда

- запросы к API идут только на `http://127.0.0.1:8765/api/v1`;
- основная страница и production-сессии не используются;
- изменения через POST/PATCH/DELETE остаются в памяти локального процесса;
- состояние и запросы можно проверить через `/__mock__/health` и `/__mock__/requests`;
- карта и интерфейс оператора остаются клиентской копией исходной сборки, но данные демонстрационные.

Для обновления копии повторно скачайте публичные HTML/JS/CSS-ресурсы и локализуйте production-origin только в JavaScript-файлах. Не направляйте тестовый mock обратно на production API.
