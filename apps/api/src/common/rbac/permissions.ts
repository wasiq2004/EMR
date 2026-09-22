/**
 * The authorisation matrix.
 *
 * It lives in `@emr/contracts` so the API guard and the web navigation read one
 * definition rather than two that drift. THIS FILE IS THE ENFORCEMENT POINT —
 * the frontend copy only decides which links to draw.
 *
 * Re-exported here so the security-review checklist still has one path to read.
 */

export {
  ACTIONS,
  ELEVATED_VISIBILITY_PERMISSIONS,
  PERMISSION_MATRIX,
  REQUIRES_MEDICAL_REGISTRATION,
  RESOURCES,
  can,
  canAll,
  canAny,
  type Action,
  type Permission,
  type Resource,
} from '@emr/contracts';
