// Checks .env.local without printing any secret.
// Usage: node scripts/check-env.mjs            (checks ./.env.local)
//        node scripts/check-env.mjs <path>     (checks another file)
import { readFileSync } from 'node:fs';

const EXPECTED_URL = 'https://twpcjrpknsqlycdvwtsj.supabase.co';
const file = process.argv[2] ?? new URL('../.env.local', import.meta.url);

let text;
try {
  text = readFileSync(file, 'utf8');
} catch {
  console.log('FAIL  could not read .env.local (it should sit next to package.json)');
  process.exit(1);
}

const vars = {};
const fails = [];
text.split(/\r?\n/).forEach((line, i) => {
  if (!line.trim() || line.trim().startsWith('#')) return;
  const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
  if (!m) return fails.push(`line ${i + 1}: expected NAME=value with no spaces around "="`);
  vars[m[1]] = m[2];
});

const url = vars.NEXT_PUBLIC_SUPABASE_URL;
if (url === undefined) fails.push('NEXT_PUBLIC_SUPABASE_URL is missing');
else if (url !== EXPECTED_URL) fails.push(`NEXT_PUBLIC_SUPABASE_URL should be exactly ${EXPECTED_URL} (no quotes, spaces or trailing slash)`);

const key = vars.NEXT_PUBLIC_SUPABASE_ANON_KEY;
let kind = 'missing';
if (key === undefined) {
  fails.push('NEXT_PUBLIC_SUPABASE_ANON_KEY is missing');
} else if (key !== key.trim() || /^["']|["']$/.test(key)) {
  kind = 'malformed';
  fails.push('NEXT_PUBLIC_SUPABASE_ANON_KEY has quotes or stray spaces - remove them');
} else if (key.startsWith('sb_publishable_')) {
  kind = 'publishable key';
} else if (key.startsWith('sb_secret_')) {
  kind = 'SECRET key';
  fails.push('That is a SECRET key. Values starting NEXT_PUBLIC_ are shipped to every visitor\'s browser. Use the PUBLISHABLE key here.');
} else if (key.startsWith('eyJ')) {
  let role = '?';
  try { role = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role; } catch { /* leave '?' */ }
  kind = `legacy JWT (${role})`;
  fails.push(role === 'service_role'
    ? 'That is a legacy SERVICE-ROLE key. It must never be in a NEXT_PUBLIC_ variable. Use the PUBLISHABLE key.'
    : 'That is a legacy JWT key, which you disabled. Replace it with the PUBLISHABLE key (sb_publishable_...).');
} else {
  kind = 'unrecognised';
  fails.push('NEXT_PUBLIC_SUPABASE_ANON_KEY does not look like a Supabase key (expected it to start with sb_publishable_)');
}

for (const name of Object.keys(vars)) {
  if (/SERVICE_ROLE|SECRET/i.test(name)) {
    fails.push(`${name}: secrets do not belong in .env.local. The Next.js app does not need one.`);
  }
}

console.log(`URL: ${url === EXPECTED_URL ? 'ok' : 'not ok'}`);
console.log(`Key type: ${kind}${key ? `, ${key.length} characters` : ''}`);
if (fails.length) {
  fails.forEach((f) => console.log('FAIL  ' + f));
  process.exit(1);
}
console.log('PASS  .env.local looks right');
