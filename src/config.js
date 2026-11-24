// All settings come from environment variables. Nothing secret lives in the code.
export function cfg() {
  const env = process.env;
  const flag = (v, dflt) => (v === undefined || v === '' ? dflt : v === '1' || v === 'true');
  return {
    email: (env.ICLOUD_EMAIL || '').trim(),
    appPassword: (env.ICLOUD_APP_PASSWORD || '').trim(),
    passphrase: env.OWNER_PASSPHRASE || '',
    tokenSecret: env.TOKEN_SECRET || '',
    fromName: (env.FROM_NAME || '').trim(),
    publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
    imap: {
      host: env.IMAP_HOST || 'imap.mail.me.com',
      port: Number(env.IMAP_PORT || 993),
      secure: flag(env.IMAP_SECURE, true),
    },
    smtp: {
      host: env.SMTP_HOST || 'smtp.mail.me.com',
      port: Number(env.SMTP_PORT || 587),
      secure: flag(env.SMTP_SECURE, false),
      requireTLS: flag(env.SMTP_REQUIRE_TLS, true),
    },
    // Test-only switches. Leave unset in production.
    tlsInsecure: flag(env.MAIL_TLS_INSECURE, false),
    allowPrivateHttp: flag(env.ALLOW_PRIVATE_HTTP, false),
  };
}

export const MIN_PASSPHRASE = 12;

export function configProblems() {
  const c = cfg();
  const problems = [];
  if (!c.email) problems.push('ICLOUD_EMAIL is not set');
  if (!c.appPassword) problems.push('ICLOUD_APP_PASSWORD is not set');
  if (!c.passphrase) problems.push('OWNER_PASSPHRASE is not set');
  else if (c.passphrase.length < MIN_PASSPHRASE) problems.push(`OWNER_PASSPHRASE is shorter than ${MIN_PASSPHRASE} characters`);
  return problems;
}
