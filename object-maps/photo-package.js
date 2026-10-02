/* A portable ZIP with point metadata and local photos, ready for district handoff. */
globalThis.SaoPhotoPackage = (() => {
  const encoder = new TextEncoder();
  const table = Uint32Array.from({length:256}, (_, value) => {
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    return value >>> 0;
  });
  function crc32(bytes) {
    let value = 0xffffffff;
    for (const byte of bytes) value = table[(value ^ byte) & 255] ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
  }
  function header(size, values) {
    const bytes = new Uint8Array(size), view = new DataView(bytes.buffer);
    for (const [offset, value, width] of values) {
      if (width === 4) view.setUint32(offset, value, true);
      else view.setUint16(offset, value, true);
    }
    return bytes;
  }
  function zip(entries) {
    if (entries.length > 65535) throw new Error('Слишком много файлов для одного архива.');
    const files = [], directory = [];
    let offset = 0, directorySize = 0;
    for (const entry of entries) {
      const name = encoder.encode(entry.name), bytes = entry.bytes, crc = crc32(bytes);
      if (offset + bytes.length + name.length + 30 > 0xffffffff) throw new Error('Архив превышает 4 ГБ. Выгрузите районы отдельно.');
      const local = header(30, [[0,0x04034b50,4],[4,20,2],[6,0x800,2],[12,33,2],[14,crc,4],[18,bytes.length,4],[22,bytes.length,4],[26,name.length,2]]);
      const central = header(46, [[0,0x02014b50,4],[4,20,2],[6,20,2],[8,0x800,2],[14,33,2],[16,crc,4],[20,bytes.length,4],[24,bytes.length,4],[28,name.length,2],[42,offset,4]]);
      files.push(local, name, bytes);
      directory.push(central, name);
      offset += local.length + name.length + bytes.length;
      directorySize += central.length + name.length;
    }
    if (offset + directorySize > 0xffffffff) throw new Error('Архив превышает 4 ГБ.');
    const end = header(22, [[0,0x06054b50,4],[8,entries.length,2],[10,entries.length,2],[12,directorySize,4],[16,offset,4]]);
    return new Blob([...files, ...directory, end], {type:'application/zip'});
  }
  async function create(datasetId, records, photos) {
    const manifest = {schemaVersion:1, datasetId, createdAt:new Date().toISOString(), records, photos:[]};
    const entries = [];
    for (const [index, photo] of photos.entries()) {
      const record = records.find(r => r.id === photo.objectId);
      if (!record) throw new Error('Фото не связано с точкой выбранного набора.');
      const reportedMime = photo.photo.type || photo.mimeType;
      const originalExtension = String(photo.filename || '').split('.').pop().toLowerCase();
      const inferredMime = {jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',heic:'image/heic',heif:'image/heif'}[originalExtension];
      const mime = !reportedMime || reportedMime === 'application/octet-stream' ? inferredMime || 'application/octet-stream' : reportedMime;
      const extension = {'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/heic':'heic','image/heif':'heif','image/heic-sequence':'heic','image/heif-sequence':'heif'}[mime] || 'bin';
      const filename = 'photos/' + record.id.replace(/[^a-zA-Z0-9_-]/g, '_') + '_' + (index + 1) + '.' + extension;
      entries.push({name:filename, bytes:new Uint8Array(await photo.photo.arrayBuffer())});
      manifest.photos.push({pointId:record.id, sourceId:record.sourceNumber, district:record.group, file:filename, originalFilename:photo.filename, mimeType:mime, performer:photo.performer, comment:photo.comment, gps:photo.gps, createdAt:photo.createdAt});
    }
    entries.unshift({name:'manifest.json',bytes:encoder.encode(JSON.stringify(manifest, null, 2))});
    entries.push({name:'README.txt',bytes:encoder.encode('Фотофиксация ТПУ и автомобильных парковок САО.\nmanifest.json содержит координаты, ID объектов, районы и привязку фото к точкам.\nНачальные точки рассчитаны по контурам ОДХ и требуют согласования места съёмки.\nАрхив подготовлен локально; передача для приёмки выполняется отдельно.\n')});
    return zip(entries);
  }
  return {create};
})();
