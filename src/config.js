// All settings come from environment variables. Nothing secret lives in the code.
//
// Mailbox 1 (the main one): ICLOUD_EMAIL + ICLOUD_APP_PASSWORD.
// More mailboxes: MAIL2_EMAIL + MAIL2_PASSWORD, MAIL3_..., up to MAIL9_.
// Known providers are recognized by the address. For an address on its own
// domain set MAILn_PROVIDER (icloud, gmail, yandex, mailru, yahoo, fastmail)
// or MAILn_IMAP_HOST and MAILn_SMTP_HOST.

const PRESETS = {
  icloud: { imap: { host: 'imap.mail.me.com', port: 993, secure: true }, smtp: { host: 'smtp.mail.me.com', port: 587, secure: false, requireTLS: true }, saveSent: 'check' },
  // Gmail stores sent mail by itself, so no copy is appended.
  gmail: { imap: { host: 'imap.gmail.com', port: 993, secure: true }, smtp: { host: 'smtp.gmail.com', port: 465, secure: true }, saveSent: 'never' },
  yandex: { imap: { host: 'imap.yandex.com', port: 993, secure: true }, smtp: { host: 'smtp.yandex.com', port: 465, secure: true }, saveSent: 'check' },
  mailru: { imap: { host: 'imap.mail.ru', port: 993, secure: true }, smtp: { host: 'smtp.mail.ru', port: 465, secure: true }, saveSent: 'check' },
  yahoo: { imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true }, smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true }, saveSent: 'check' },
  fastmail: { imap: { host: 'imap.fastmail.com', port: 993, secure: true }, smtp: { host: 'smtp.fastmail.com', port: 465, secure: true }, saveSent: 'check' },
};

const DOMAINS = {
  'icloud.com': 'icloud', 'me.com': 'icloud', 'mac.com': 'icloud',
  'gmail.com': 'gmail', 'googlemail.com': 'gmail',
  'yandex.ru': 'yandex', 'yandex.com': 'yandex', 'yandex.kz': 'yandex', 'ya.ru': 'yandex',
  'mail.ru': 'mailru', 'inbox.ru': 'mailru', 'list.ru': 'mailru', 'bk.ru': 'mailru', 'internet.ru': 'mailru',
  'yahoo.com': 'yahoo',
  'fastmail.com': 'fastmail',
};

const MICROSOFT = ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'];

const flag = (v, dflt) => (v === undefined || v === '' ? dflt : v === '1' || v === 'true');

function buildAccount(n, raw, fallbackProvider) {
  const email = (raw.email || '').trim();
  const domain = email.split('@')[1]?.toLowerCase() || '';
  const providerName = (raw.provider || '').trim().toLowerCase() || DOMAINS[domain] || fallbackProvider || '';
  const preset = PRESETS[providerName];
  const acct = {
    id: n,
    email,
    user: (raw.user || '').trim() || email,
    password: (raw.password || '').trim(),
    fromName: (raw.fromName || '').trim(),
    provider: preset ? providerName : raw.imapHost ? 'custom' : providerName || 'unknown',
    saveSent: ['always', 'never', 'check'].includes(raw.saveSent) ? raw.saveSent : preset?.saveSent || 'check',
    imap: null,
    smtp: null,
    problem: null,
  };
  const imapHost = raw.imapHost || preset?.imap.host;
  const smtpHost = raw.smtpHost || preset?.smtp.host;
  if (!email) acct.problem = `MAIL${n}_EMAIL is not set`;
  else if (!acct.password) acct.problem = n === 1 ? 'ICLOUD_APP_PASSWORD is not set' : `MAIL${n}_PASSWORD is not set`;
  else if (raw.provider && !preset && !raw.imapHost) acct.problem = `Unknown provider "${raw.provider}". Known: ${Object.keys(PRESETS).join(', ')}`;
  else if (!imapHost || !smtpHost) {
    acct.problem = MICROSOFT.includes(domain)
      ? 'Microsoft mailboxes (Outlook, Hotmail, Microsoft 365) do not accept password sign-in over IMAP and SMTP, so this server cannot reach them'
      : `The mail servers for ${domain || 'this address'} are not known. Set MAIL${n}_PROVIDER (${Object.keys(PRESETS).join(', ')}) or MAIL${n}_IMAP_HOST and MAIL${n}_SMTP_HOST`;
  }
  if (imapHost && smtpHost) {
    acct.imap = {
      host: imapHost,
      port: Number(raw.imapPort || (raw.imapHost ? 993 : preset.imap.port)),
      secure: flag(raw.imapSecure, raw.imapHost ? true : preset.imap.secure),
    };
    const smtpSecure = flag(raw.smtpSecure, raw.smtpHost ? Number(raw.smtpPort || 465) === 465 : preset.smtp.secure);
    acct.smtp = {
      host: smtpHost,
      port: Number(raw.smtpPort || (raw.smtpHost ? (smtpSecure ? 465 : 587) : preset.smtp.port)),
      secure: smtpSecure,
      requireTLS: flag(raw.smtpRequireTLS, true),
    };
  }
  return acct;
}

export function accounts() {
  const env = process.env;
  const list = [
    buildAccount(1, {
      email: env.ICLOUD_EMAIL,
      password: env.ICLOUD_APP_PASSWORD,
      fromName: env.FROM_NAME,
      provider: env.MAIL1_PROVIDER,
      imapHost: env.IMAP_HOST, imapPort: env.IMAP_PORT, imapSecure: env.IMAP_SECURE,
      smtpHost: env.SMTP_HOST, smtpPort: env.SMTP_PORT, smtpSecure: env.SMTP_SECURE, smtpRequireTLS: env.SMTP_REQUIRE_TLS,
      saveSent: env.MAIL1_SAVE_SENT,
    }, 'icloud'),
  ];
  for (let n = 2; n <= 9; n++) {
    const p = `MAIL${n}_`;
    if (!env[`${p}EMAIL`] && !env[`${p}PASSWORD`]) continue;
    list.push(buildAccount(n, {
      email: env[`${p}EMAIL`],
      password: env[`${p}PASSWORD`],
      user: env[`${p}USER`],
      fromName: env[`${p}FROM_NAME`] || env.FROM_NAME,
      provider: env[`${p}PROVIDER`],
      imapHost: env[`${p}IMAP_HOST`], imapPort: env[`${p}IMAP_PORT`], imapSecure: env[`${p}IMAP_SECURE`],
      smtpHost: env[`${p}SMTP_HOST`], smtpPort: env[`${p}SMTP_PORT`], smtpSecure: env[`${p}SMTP_SECURE`], smtpRequireTLS: env[`${p}SMTP_REQUIRE_TLS`],
      saveSent: env[`${p}SAVE_SENT`],
    }));
  }
  return list;
}

// Picks a mailbox by its address, the part before @, or its number. No name means the main one.
export function resolveAccount(name) {
  const list = accounts();
  const wanted = String(name ?? '').trim().toLowerCase();
  let acct;
  if (!wanted) acct = list[0];
  else {
    acct = list.find((a) => a.email.toLowerCase() === wanted) || list.find((a) => String(a.id) === wanted);
    if (!acct) {
      const byLocal = list.filter((a) => a.email.toLowerCase().split('@')[0] === wanted);
      const byProvider = list.filter((a) => a.provider === wanted);
      if (byLocal.length === 1) acct = byLocal[0];
      else if (byProvider.length === 1) acct = byProvider[0];
    }
  }
  if (!acct) throw new Error(`No mailbox "${name}". Connected mailboxes: ${list.map((a) => a.email).join(', ')}`);
  if (acct.problem) throw new Error(`Mailbox ${acct.email || `#${acct.id}`} is not usable: ${acct.problem}`);
  return acct;
}

export function cfg() {
  const env = process.env;
  return {
    email: (env.ICLOUD_EMAIL || '').trim(),
    appPassword: (env.ICLOUD_APP_PASSWORD || '').trim(),
    passphrase: env.OWNER_PASSPHRASE || '',
    tokenSecret: env.TOKEN_SECRET || '',
    publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
    // Test-only switches. Leave unset in production.
    tlsInsecure: flag(env.MAIL_TLS_INSECURE, false),
    allowPrivateHttp: flag(env.ALLOW_PRIVATE_HTTP, false),
  };
}

export const MIN_PASSPHRASE = 12;

// Problems that keep the whole server locked. A broken extra mailbox does not lock it:
// that one is reported by list_accounts and when it is used.
export function configProblems() {
  const c = cfg();
  const problems = [];
  if (!c.email) problems.push('ICLOUD_EMAIL is not set');
  if (!c.appPassword) problems.push('ICLOUD_APP_PASSWORD is not set');
  if (!c.passphrase) problems.push('OWNER_PASSPHRASE is not set');
  else if (c.passphrase.length < MIN_PASSPHRASE) problems.push(`OWNER_PASSPHRASE is shorter than ${MIN_PASSPHRASE} characters`);
  return problems;
}
