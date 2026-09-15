# План первой production-версии фотослужбы САО

## Capability map

| Модуль | Ответственность | Зависит от |
|---|---|---|
| data | импорт и устойчивые ключи объектов, `odh_id + district` | — |
| identity | индивидуальные аккаунты, сессии, district/prefecture ACL | data |
| media | валидация, хранение, GPS-метаданные, review state | data, identity |
| reporting | экранные данные, полный Excel с фото, краткий PDF | data, identity, media |
| web-client | отдельные desktop/mobile сценарии и карты | identity, media, reporting |
| operations | Compose, migrations, backups, monitoring, staged deploy | data, identity, media, reporting |

Порядок: `data → identity → media → reporting → web-client → operations`.

## Tasks

- [ ] Data migration/import: создать отдельную PostgreSQL-схему и идемпотентный импорт трёх текущих map-data плюс районных полигонов; сохранить `unassigned` без молчаливого назначения.
- [ ] Identity: реализовать invite/setup, scrypt-хэши, httpOnly-сессии, rate limit, district/prefecture authorization и audit log; добавить CLI создания пользователей без пароля в аргументах.
- [ ] Media: реализовать multipart upload с лимитом 20 МБ, JPEG/PNG/WebP, безопасным storage key, отдельным volume, idempotency key и GPS review/risk state.
- [ ] Reporting: API summary, разрезы по типам, ExcelJS workbook с вложенными фото/метаданными, PDFKit краткую сводку; не включать pending в confirmed.
- [ ] Web client: заменить IndexedDB photo path на API client, добавить login/session/retry states, desktop concept 2 и mobile concept 5; сохранить атрибуцию и route/nozzle arrows.
- [ ] Operations: health/readiness, backup/restore scripts, own production Compose project `/opt/sao-photo-service`, reverse-proxy `/photo-api/`, smoke/rollback runbook.

## Release gates

1. `npm test`, import fixture checks, dependency audit/signatures.
2. Local Compose migration/upload/download/export smoke with no legacy resources.
3. Staging or isolated production host dry run, backup and restore verification.
4. Deploy with rollback point, then authenticated non-destructive health/report smoke.
5. Manual desktop 1280×800 and mobile 390×844 checks, followed by controlled user rollout.
