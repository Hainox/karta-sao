import { summarizeCoverageByType, summarizeCoverage, summarizeByDistrict } from './report.js';
import { PHOTO_NORM_SINCE, PHOTO_REQUIREMENTS } from './completion.js';
import { AUTODOR_OBJECT_SQL, districtMatchSql, districtScopeSql, isAutodorAccount } from './scope.js';

const TYPES = new Set(['stop', 'pp', 'entrance']);
// Объекты без района показываются префектуре списком: это данные источника, а не
// ошибка расчёта, но их надо видеть — иначе «7 объектов» останутся числом без имён.
const UNASSIGNED_LIST_LIMIT = 100;

// Норма кадров на точку по видам — та же карта, что в completion.js: у перехода
// снимают оба направления. Значения целые и берутся из кода, а не из запроса.
const PHOTO_NORM_SQL = `CASE o.object_type ${Object.entries(PHOTO_REQUIREMENTS)
  .map(([type, norm]) => `WHEN '${type}' THEN ${norm}`)
  .join(' ')} ELSE 1 END`;

function scopeClause(user, requestedDistrict) {
  // Учётка АвД ведёт объекты владельца по всему округу, а не по одному району.
  if (user.role === 'district_editor') {
    if (isAutodorAccount(user.district)) return { sql: AUTODOR_OBJECT_SQL, params: [] };
    // Район видит только свои объекты: объекты «АвД САО» и «ДЭУ N» ведёт владелец,
    // даже если они стоят на территории района.
    return { sql: districtScopeSql('$1'), params: [user.district] };
  }
  if (requestedDistrict && requestedDistrict !== 'all') return { sql: districtScopeSql('$1'), params: [requestedDistrict] };
  return { sql: 'TRUE', params: [] };
}

export async function loadReportRows(pool, user, requestedDistrict, { includeRejected = false, reviewOnly = false, reviewOwner = '' } = {}) {
  const scope = scopeClause(user, requestedDistrict);
  // Район должен видеть возвращённый кадр и причину доработки на той же карте,
  // с которой он его отправлял. Префектура получает rejected только в очереди.
  const canSeeRejected = user.role === 'prefecture_admin' || user.role === 'district_editor';
  const photoJoin = includeRejected && canSeeRejected
    ? "p.review_status <> 'withdrawn'"
    : "p.review_status NOT IN ('rejected', 'withdrawn')";
  const claimParameter = scope.params.length + 1;
  const queueFilter = reviewOnly
    ? `AND EXISTS (SELECT 1 FROM photos pending_photo WHERE pending_photo.object_key = o.object_key AND pending_photo.review_status IN ('pending_review', 'rejected'))${reviewOwner ? ` AND NOT EXISTS (SELECT 1 FROM review_claims active_claim WHERE active_claim.object_key = o.object_key AND active_claim.expires_at > now() AND active_claim.owner_key <> $${claimParameter})` : ''}`
    : '';
  const queryParams = reviewOwner ? [...scope.params, reviewOwner] : scope.params;
  const result = await pool.query(`
    SELECT o.object_key, o.dataset_id, o.object_type, o.report_key, o.source_ids, o.district,
           o.label, o.reference_points, o.properties, o.source_version,
           -- Балансодержатель и ОДХ лежат в свойствах под разными именами по наборам:
           -- у остановок «Балансодержатель», у ПП «Баланс», у подъездов своего нет.
           coalesce(nullif(o.properties->>'Балансодержатель', ''), nullif(o.properties->>'Баланс', '')) AS balance_holder,
           nullif(o.properties->>'ID объекта ОДХ', '') AS odh_id,
           -- Единица учёта — точка источника: у одного перехода их может быть много.
           coalesce(array_length(o.source_ids, 1), 0) AS source_point_count,
           -- Закрытая точка — та, где кадров набралось на норму вида (у перехода два).
           -- Считаем точки, а не кадры: второй снимок перехода не удваивает ФАКТ.
           -- Всё, что снято до введения нормы (PHOTO_NORM_SINCE), засчитывается по
           -- прежнему правилу: тогда хватало одного кадра, и это была наша недоработка.
           coalesce((
             SELECT count(1)::int FROM (
               SELECT p2.source_id
               FROM photos p2
               WHERE p2.object_key = o.object_key
                 AND p2.source_id IS NOT NULL
                 AND p2.review_status NOT IN ('rejected', 'withdrawn')
               GROUP BY p2.source_id
               HAVING count(1) >= (${PHOTO_NORM_SQL})
                   OR max(p2.uploaded_at) < TIMESTAMPTZ '${PHOTO_NORM_SINCE}'
             ) closed
           ), 0) AS covered_points,
           count(p.id) FILTER (WHERE p.source_id IS NULL)::int AS unbound_photos,
           count(p.id) FILTER (WHERE p.review_status = 'confirmed')::int AS confirmed_photos,
           count(p.id) FILTER (WHERE p.review_status = 'pending_review')::int AS pending_review_photos,
           json_agg(json_build_object(
             'id', p.id, 'storageKey', p.storage_key, 'thumbnailKey', p.thumbnail_key, 'mimeType', p.mime_type,
             'originalFilename', p.original_filename, 'byteSize', p.byte_size, 'sha256', p.sha256,
             'performer', p.performer, 'comment', p.comment, 'capturedAt', p.captured_at,
             'uploadedAt', p.uploaded_at, 'gpsLatitude', p.gps_latitude,
             'gpsLongitude', p.gps_longitude, 'gpsAccuracyM', p.gps_accuracy_m,
             'distanceM', p.distance_m, 'geoStatus', p.geo_status, 'sourceId', p.source_id,
             'reviewStatus', p.review_status, 'reviewReason', p.review_reason,
             'reviewedAt', p.reviewed_at, 'uploadedBy', p.uploaded_by,
             'isReference', p.is_reference
           ) ORDER BY p.uploaded_at) FILTER (WHERE p.id IS NOT NULL) AS photos
    FROM objects o
    LEFT JOIN photos p ON p.object_key = o.object_key AND ${photoJoin}
    WHERE ${scope.sql} ${queueFilter}
    GROUP BY o.object_key
    ORDER BY o.district NULLS LAST, o.object_type, o.label, o.object_key
  `, queryParams);
  return result.rows.map((row) => ({
    ...row,
    confirmedPhotos: Number(row.confirmed_photos),
    pendingReviewPhotos: Number(row.pending_review_photos),
    sourcePointCount: Number(row.source_point_count) || 0,
    coveredPoints: Number(row.covered_points) || 0,
    unboundPhotos: Number(row.unbound_photos) || 0,
    photos: Array.isArray(row.photos) ? row.photos : [],
  }));
}

export function reportPayload(rows) {
  const unassignedRows = rows.filter((row) => row.district === null || row.district === undefined || row.district === '');
  // Сводка САО считается по всему набору: объекты без района больше не выпадают
  // из неё, а учтены в строке «АвД САО» вместе с объектами владельца и «ДЭУ» —
  // иначе ИТОГО районов не сходилось бы с общим числом объектов.
  const coverageOf = (row) => ({
    objectType: row.object_type,
    confirmedPhotos: row.confirmedPhotos,
    pendingReviewPhotos: row.pendingReviewPhotos,
    sourcePointCount: row.sourcePointCount,
    coveredPoints: row.coveredPoints,
  });
  const records = rows.map(coverageOf);
  // Distinct source revisions are surfaced so a report cannot silently mix datasets.
  const sourceVersions = [...new Set(rows.map((row) => row.source_version).filter(Boolean))].sort();
  return {
    generatedAt: new Date().toISOString(),
    sourceVersions,
    overall: summarizeCoverage(records),
    byType: summarizeCoverageByType(records),
    // Разрез по районам считается здесь же: боковой дашборд префектуры и отчёты
    // показывают одни и те же числа, а не две независимые реализации.
    byDistrict: summarizeByDistrict(rows),
    unassigned: {
      ...summarizeCoverage(unassignedRows.map(coverageOf)),
      objects: unassignedRows.slice(0, UNASSIGNED_LIST_LIMIT).map((row) => ({
        objectKey: row.object_key,
        objectType: row.object_type,
        label: row.label,
        balanceHolder: row.balance_holder || null,
        sourcePoints: row.sourcePointCount,
        sourceIds: row.source_ids,
      })),
      listLimit: UNASSIGNED_LIST_LIMIT,
    },
    objects: rows.map((row) => ({
      objectKey: row.object_key,
      datasetId: row.dataset_id,
      objectType: row.object_type,
      reportKey: row.report_key,
      sourceIds: row.source_ids,
      district: row.district,
      label: row.label,
      balanceHolder: row.balance_holder || null,
      odhId: row.odh_id || null,
      referencePoints: row.reference_points,
      sourceVersion: row.source_version,
      confirmedPhotos: row.confirmedPhotos,
      pendingReviewPhotos: row.pendingReviewPhotos,
      sourcePointCount: row.sourcePointCount,
      coveredPoints: row.coveredPoints,
      unboundPhotos: row.unboundPhotos,
      photos: row.photos,
    })),
  };
}

export function validateType(value) {
  if (value === undefined || value === '') return undefined;
  if (!TYPES.has(value)) throw Object.assign(new Error('invalid_object_type'), { statusCode: 400 });
  return value;
}
