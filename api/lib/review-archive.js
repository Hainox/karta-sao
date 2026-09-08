import archiver from 'archiver';

const safeSegment = (value) => String(value || 'без-района')
  .normalize('NFC')
  .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 80) || 'без-района';

const archiveTimestamp = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? 'без-даты'
    : date.toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
};

export function reviewArchiveEntries(submissions) {
  return submissions.map((submission, index) => {
    const id = safeSegment(submission.id || `набор-${index + 1}`);
    return {
      path: `районы/${safeSegment(submission.district)}/${archiveTimestamp(submission.submitted_at)}__${id}.geojson`,
      id: submission.id,
      district: submission.district,
      author: submission.author,
      original_filename: submission.original_filename,
      submitted_at: submission.submitted_at,
      payload_sha256: submission.payload_sha256,
      feature_count: submission.change_set?.features?.length || 0,
      changeSet: submission.change_set
    };
  });
}

export async function streamReviewArchive(response, submissions, { exportedAt = new Date().toISOString() } = {}) {
  const entries = reviewArchiveEntries(submissions);
  const archive = archiver('zip', { zlib: { level: 9 } });
  const completed = new Promise((resolve, reject) => {
    archive.once('error', reject);
    response.once('error', reject);
    response.once('finish', resolve);
  });
  archive.pipe(response);
  archive.append(JSON.stringify({
    archive_version: 'district_review_archive_v1',
    exported_at: exportedAt,
    selection: { status: 'submitted', submissions: entries.length },
    files: entries.map(({ path, changeSet, ...entry }) => ({ path, ...entry }))
  }, null, 2), { name: 'manifest.json' });
  entries.forEach(({ path, changeSet }) => archive.append(JSON.stringify(changeSet, null, 2), { name: path }));
  await archive.finalize();
  await completed;
}
