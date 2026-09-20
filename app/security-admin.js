// Two-step sign-in for the Partner Portal: setting it up, using it at sign-in, and turning it on for everyone.
// No React and no network here, so it can be tested on its own.

export function friendlyError(error) {
  const msg = String(error?.message ?? error ?? '');
  if (/invalid totp code|invalid code|verification failed/i.test(msg)) return 'That code did not match. Check the app and try the next code.';
  if (/rate limit|too many/i.test(msg)) return 'Too many tries. Wait a minute and try again.';
  if (/Set up two-step sign-in/i.test(msg)) return msg;
  if (/Only a Kidscover admin/i.test(msg)) return 'Only a Kidscover admin can change this.';
  if (/security_settings|set_require_mfa|schema cache|PGRST202/i.test(msg)) return 'Run the 20260920000500_account_and_security.sql migration first.';
  if (/network|failed to fetch/i.test(msg)) return 'Could not reach the server. Check the connection and try again.';
  return msg || 'Something went wrong.';
}

export const cleanCode = (text) => String(text ?? '').replace(/\D/g, '').slice(0, 6);
export const codeReady = (text) => cleanCode(text).length === 6;

// The authenticator factors on this account, and whether one is ready to use.
export async function loadFactors(auth) {
  const { data, error } = await auth.mfa.listFactors();
  const totp = data?.totp ?? [];
  return { factors: totp, ready: totp.some((f) => f.status === 'verified'), error: error ?? null };
}

// Does this sign-in still need its second step? Supabase answers with the level it is at and the level it should reach.
export async function needsSecondStep(auth) {
  const { data, error } = await auth.mfa.getAuthenticatorAssuranceLevel();
  if (error) return { needed: false, error };
  return { needed: data?.currentLevel === 'aal1' && data?.nextLevel === 'aal2', level: data?.currentLevel ?? null, error: null };
}

// Starts setting up an authenticator app: gives back the QR code to scan and the typed-out secret as a fallback.
export async function startSetup(auth, friendlyName = 'Kidscover Portal') {
  const { data, error } = await auth.mfa.enroll({ factorType: 'totp', friendlyName: `${friendlyName} ${new Date().toISOString().slice(0, 10)}` });
  if (error) return { error };
  return { factorId: data?.id, qr: data?.totp?.qr_code ?? '', secret: data?.totp?.secret ?? '', error: null };
}

export async function finishSetup(auth, factorId, code) {
  if (!codeReady(code)) return { error: { message: 'Enter the 6-digit code from your authenticator app.' } };
  const { error } = await auth.mfa.challengeAndVerify({ factorId, code: cleanCode(code) });
  return { error: error ?? null };
}

export async function signInStep(auth, factorId, code) {
  if (!codeReady(code)) return { error: { message: 'Enter the 6-digit code from your authenticator app.' } };
  const { error } = await auth.mfa.challengeAndVerify({ factorId, code: cleanCode(code) });
  return { error: error ?? null };
}

export const removeFactor = async (auth, factorId) => ({ error: (await auth.mfa.unenroll({ factorId }))?.error ?? null });

export async function loadRequireMfa(db) {
  const { data, error } = await db.from('security_settings').select('require_mfa').eq('id', 1).maybeSingle();
  return { required: !!data?.require_mfa, error: error ?? null };
}

export async function setRequireMfa(db, on) {
  const { error } = await db.rpc('set_require_mfa', { p_on: !!on });
  return { error: error ?? null };
}

// What the Security page says about where this account stands.
export function securityLine({ ready, required, level }) {
  if (required && ready) return 'Two-step sign-in is required, and your account is set up for it.';
  if (required && !ready) return 'Two-step sign-in is required. Set it up now, or you will not be able to work in the portal.';
  if (!required && ready) return 'Your account asks for a code at sign-in. It is not yet required for everyone.';
  return level === 'aal2'
    ? 'Your account asks for a code at sign-in.'
    : 'Your account is protected by a password only. Setting up two-step sign-in is the single biggest thing you can do here.';
}
