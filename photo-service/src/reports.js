import { summarizeCoverageByType, summarizeCoverage, summarizeByDistrict } from './report.js';

const TYPES = new Set(['stop', 'pp', 'entrance']);

function scopeClause(user, requestedDistrict) {
  if (user.role === 'district_editor') return { sql: 'o.district = $1', params: [user.district] };
  if (requestedDistrict && requestedDistrict !== 'all') return { sql: 'o.district = $1', params: [requestedDistrict] };
  return { sql: 'TRUE', params: [] };
}

export async function loadReportRows(pool, user, requestedDistrict) {
  const scope = scopeClause(user, requestedDistrict);
  const result = await pool.query(`
    SELECT o.object_key, o.dataset_id, o.object_type, o.report_key, o.source_ids, o.district,
           o.label, o.reference_points, o.properties, o.source_version,
           -- Балансодержатель и ОДХ лежат в свойствах под разными именами по наборам:
           -- у остановок «Балансодержатель», у ПП «Баланс», у подъездов своего нет.
           coalesce(nullif(o.properties->>'Балансодержатель', ''), nullif(o.properties->>'Баланс', '')) AS balance_holder,
           nullif(o.properties->>'ID объекта ОДХ', '') AS odh_id,
           -- Единица учёта — точка источника: у одного перехода их может быть много.
           coalesce(array_length(o.source_ids, 1), 0) AS source_point_count,
           count(DISTINCT p.source_id)::int AS covered_points,
           count(p.id) FILTER (WHERE p.source_id IS NULL)::int AS unbound_photos,
           count(p.id) FILTER (WHERE p.review_status = 'confirmed')::int AS confirmed_photos,
           count(p.id) FILTER (WHERE p.review_status = 'pending_review')::int AS pending_review_photos,
           coalesce(bool_or(p.geo_status = 'risk'), false) AS geo_risk,
           json_agg(json_build_object(
             'id', p.id, 'storageKey', p.storage_key, 'thumbnailKey', p.thumbnail_key, 'mimeType', p.mime_type,
             'originalFilename', p.original_filename, 'byteSize', p.byte_size, 'sha256', p.sha256,
             'performer', p.performer, 'comment', p.comment, 'capturedAt', p.captured_at,
             'uploadedAt', p.uploaded_at, 'gpsLatitude', p.gps_latitude,
             'gpsLongitude', p.gps_longitude, 'gpsAccuracyM', p.gps_accuracy_m,
             'distanceM', p.distance_m, 'geoStatus', p.geo_status, 'sourceId', p.source_id,
             'reviewStatus', p.review_status, 'reviewReason', p.review_reason,
             'isReference', p.is_reference
           ) ORDER BY p.uploaded_at) FILTER (WHERE p.id IS NOT NULL) AS photos
    FROM objects o
    LEFT JOIN photos p ON p.object_key = o.object_key AND p.review_status <> 'rejected'
    WHERE ${scope.sql}
    GROUP BY o.object_key
    ORDER BY o.district NULLS LAST, o.object_type, o.label, o.object_key
  `, scope.params);
  return result.rows.map((row) => ({
    ...row,
    confirmedPhotos: Number(row.confirmed_photos),
    pendingReviewPhotos: Number(row.pending_review_photos),
    sourcePointCount: Number(row.source_point_count) || 0,
    coveredPoints: Number(row.covered_points) || 0,
    unboundPhotos: Number(row.unbound_photos) || 0,
    geoRisk: row.geo_risk === true,
    photos: Array.isArray(row.photos) ? row.photos : [],
  }));
}

export function reportPayload(rows) {
  const assignedRows = rows.filter((row) => row.district !== null && row.district !== undefined && row.district !== '');
  const unassignedRows = rows.filter((row) => !assignedRows.includes(row));
  const records = assignedRows.map((row) => ({
    objectType: row.object_type,
    confirmedPhotos: row.confirmedPhotos,
    pendingReviewPhotos: row.pendingReviewPhotos,
    geoRisk: row.geoRisk,
    sourcePointCount: row.sourcePointCount,
    coveredPoints: row.coveredPoints,
  }));
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
    unassigned: summarizeCoverage(unassignedRows.map((row) => ({
      objectType: row.object_type,
      confirmedPhotos: row.confirmedPhotos,
      pendingReviewPhotos: row.pendingReviewPhotos,
      geoRisk: row.geoRisk,
      sourcePointCount: row.sourcePointCount,
      coveredPoints: row.coveredPoints,
    }))),
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
      geoRisk: row.geoRisk,
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
