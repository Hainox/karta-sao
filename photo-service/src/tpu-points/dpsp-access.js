import { normalizeDistrict } from '../scope.js';
import { DISTRICTS } from './validation.js';

export const DPSP_EDITOR = 'dpsp_district_editor';

export function dpspDistrict(value) {
  return [...DISTRICTS].find(district => normalizeDistrict(district) === normalizeDistrict(value));
}

export function dpspSessionAllowed(user, path) {
  return user.role !== DPSP_EDITOR || path === '/auth/me' || path.startsWith('/object-photo-points/dpsp/');
}

export function requireDpspAdmin(req, res, next) {
  if (req.user.role === 'prefecture_admin') return next();
  return res.status(403).json({ error: 'Раздел доступен только администратору.' });
}

// SQL expressions come from the caller. Only the district value comes from the session.
export function dpspDistrictClause(user, column, params) {
  if (user?.role !== DPSP_EDITOR) return '';
  params.push(normalizeDistrict(user.district));
  return ` AND replace(lower(btrim(${column})), 'ё', 'е')=$${params.length}`;
}

export function dpspPointChildClause(user, item, params) {
  const district = dpspDistrictClause(user, 'p.district', params);
  return district
    ? ` AND EXISTS (SELECT 1 FROM playground_photo_points p WHERE p.id=${item}.point_id AND p.retired_at IS NULL${district})`
    : '';
}
