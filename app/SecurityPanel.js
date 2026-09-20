'use client';

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/utils/supabase';
import {
  loadFactors, startSetup, finishSetup, removeFactor, loadRequireMfa, setRequireMfa, securityLine, friendlyError, cleanCode,
} from './security-admin';

const btn = 'px-3 py-1.5 rounded text-sm font-bold disabled:opacity-50';

// Two-step sign-in: set it up for this account, and (for a Kidscover admin) require it for everyone who works here.
export default function SecurityPanel({ isAdmin = false, level = null }) {
  const [factors, setFactors] = useState([]);
  const [ready, setReady] = useState(false);
  const [required, setRequired] = useState(false);
  const [setup, setSetup] = useState(null);   // { factorId, qr, secret }
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const apply = useCallback(([f, r]) => {
    if (f.error) setError(friendlyError(f.error));
    setFactors(f.factors);
    setReady(f.ready);
    if (!r.error) setRequired(r.required);
  }, []);
  const both = () => Promise.all([loadFactors(supabase.auth), loadRequireMfa(supabase)]);
  const load = useCallback(() => both().then(apply), [apply]);
  useEffect(() => { Promise.all([loadFactors(supabase.auth), loadRequireMfa(supabase)]).then(apply); }, [apply]);

  async function begin() {
    setBusy(true); setError(''); setNotice('');
    const res = await startSetup(supabase.auth);
    setBusy(false);
    if (res.error) { setError(friendlyError(res.error)); return; }
    setSetup(res);
  }

  async function confirm() {
    setBusy(true); setError(''); setNotice('');
    const res = await finishSetup(supabase.auth, setup.factorId, code);
    setBusy(false);
    if (res.error) { setError(friendlyError(res.error)); return; }
    setSetup(null); setCode('');
    setNotice('Two-step sign-in is on for your account. Keep your recovery codes from the app somewhere safe.');
    await load();
  }

  async function forget(factorId) {
    setBusy(true); setError(''); setNotice('');
    const res = await removeFactor(supabase.auth, factorId);
    setBusy(false);
    if (res.error) { setError(friendlyError(res.error)); return; }
    setNotice('Removed. Your account is back to a password only.');
    await load();
  }

  async function toggleRequired(on) {
    setBusy(true); setError(''); setNotice('');
    const res = await setRequireMfa(supabase, on);
    setBusy(false);
    if (res.error) { setError(friendlyError(res.error)); return; }
    setRequired(on);
    setNotice(on
      ? 'Two-step sign-in is now required for every Kidscover admin and every school\'s staff.'
      : 'Two-step sign-in is no longer required. Accounts that have it set up still use it.');
  }

  return (
    <div className="bg-white text-gray-900 border border-gray-200 rounded-xl shadow-sm p-6" data-testid="security-panel">
      <h2 className="text-lg font-bold mb-1">Security</h2>
      <p data-testid="security-line" className="text-sm text-gray-600 mb-4">{securityLine({ ready, required, level })}</p>
      {error && <p data-testid="security-error" className="text-sm font-bold text-red-700 bg-red-50 border border-red-200 rounded p-3 mb-3">{error}</p>}
      {notice && <p data-testid="security-notice" className="text-sm font-bold text-green-700 bg-green-50 border border-green-200 rounded p-3 mb-3">{notice}</p>}

      <section className="mb-6">
        <h3 className="font-bold mb-2">Your own sign-in</h3>
        {factors.length > 0 ? (
          <ul className="space-y-1 mb-2">
            {factors.map((f) => (
              <li key={f.id} data-testid={`factor-${f.id}`} className="text-sm flex justify-between items-center border border-gray-100 rounded p-2">
                <span>{f.friendly_name || 'Authenticator app'} <span className="text-gray-500">({f.status === 'verified' ? 'ready' : 'not finished'})</span></span>
                <button data-testid={`factor-remove-${f.id}`} disabled={busy} onClick={() => forget(f.id)} className={`${btn} bg-gray-200 text-gray-800 text-xs`}>Remove</button>
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-gray-600 mb-2">No authenticator app set up yet.</p>}

        {!setup ? (
          <button data-testid="mfa-start" disabled={busy} onClick={begin} className={`${btn} bg-blue-600 text-white`}>Set up an authenticator app</button>
        ) : (
          <div className="border border-gray-200 rounded p-3 bg-gray-50" data-testid="mfa-setup">
            <p className="text-sm mb-2">
              Scan this with Google Authenticator, Microsoft Authenticator or 1Password, then type the 6-digit code it shows.
            </p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {!!setup.qr && <img data-testid="mfa-qr" src={setup.qr} alt="Code to scan with your authenticator app" className="w-40 h-40 bg-white border border-gray-200 rounded" />}
            <p className="text-xs text-gray-600 mt-1">Cannot scan? Type this key instead: <span data-testid="mfa-secret" className="font-mono">{setup.secret}</span></p>
            <div className="flex gap-2 mt-2">
              <input data-testid="mfa-code" value={code} onChange={(e) => setCode(cleanCode(e.target.value))} inputMode="numeric" placeholder="123456"
                className="w-28 border border-gray-300 rounded px-2 py-1 text-sm text-black" />
              <button data-testid="mfa-confirm" disabled={busy} onClick={confirm} className={`${btn} bg-blue-600 text-white`}>Turn it on</button>
              <button data-testid="mfa-cancel" disabled={busy} onClick={() => { setSetup(null); setCode(''); }} className={`${btn} bg-gray-200 text-gray-800`}>Cancel</button>
            </div>
          </div>
        )}
      </section>

      {isAdmin && (
        <section>
          <h3 className="font-bold mb-2">Everyone who works in the portal</h3>
          <p className="text-sm text-gray-600 mb-2">
            With this on, a Kidscover admin or a school&apos;s staff member sees nothing in the portal until they have
            entered a code from their authenticator app. It is the strongest protection for families&apos; details, and a
            stolen password on its own stops being enough.
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input data-testid="mfa-required" type="checkbox" checked={required} disabled={busy} onChange={(e) => toggleRequired(e.target.checked)} />
            Require two-step sign-in for every Kidscover admin and school staff member
          </label>
          {!ready && <p className="text-xs text-amber-800 mt-1">Set it up for your own account first; the database will not let you lock yourself out.</p>}
          <p className="text-xs text-gray-500 mt-2">
            If everyone loses their codes, a Supabase project owner can switch this off in the SQL editor:
            <span className="font-mono"> update public.security_settings set require_mfa = false where id = 1;</span>
          </p>
        </section>
      )}
    </div>
  );
}
