/**
 * Canonical secret names, matching `servermanage/settings/schema.py`.
 *
 * The values live in `app_secrets` as DPAPI-protected blobs (see
 * `../storage/secrets` + `../storage/dpapi`); they are never written into
 * `app_settings` and never echoed in clear text.
 */
export const SECRET_SMTP_PASSWORD = 'smtp:password';
export const SECRET_WEBHOOK_URL = 'webhook:url';
export const SECRET_ADMIN = 'dashboard:admin_password';
export const SECRET_SESSION = 'dashboard:session_secret';
