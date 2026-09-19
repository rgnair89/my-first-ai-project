'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/utils/supabase';
import {
  FACILITIES, ACHIEVEMENT_KINDS, SOURCE_LABELS, LEVEL_NAMES, LEVEL_ORDER, kindLabel, levelsText, levelsSourceText, setLevels,
  friendlyError, loadProfile, findSchools, loadMySchools,
  setFacility, saveAchievement, deleteAchievement, uploadPhoto, chooseWikimediaPhoto, removePhoto, searchWikimedia,
  photoCredit, loadStaff, addStaff, removeStaff, loadChanges, revertChange, describeChange, whoText, canRevert,
} from './profiles-admin';

const when = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};
const EMPTY_ACH = { id: null, kind: 'class10', text: '', year: '', url: '' };
const btn = 'px-3 py-1.5 rounded text-sm font-bold disabled:opacity-50';

// mode 'admin': a Kidscover admin, who can open any school, manage its staff and undo changes.
// mode 'staff': a school's own staff, who see only the schools they look after.
export default function SchoolProfilePanel({ mode = 'admin', userId = null }) {
  const isAdmin = mode === 'admin';
  const [schoolId, setSchoolId] = useState(null);
  const [mine, setMine] = useState([]);
  const [term, setTerm] = useState('');
  const [results, setResults] = useState([]);
  const [recent, setRecent] = useState([]);
  const [profile, setProfile] = useState(null);
  const [staff, setStaff] = useState([]);
  const [changes, setChanges] = useState([]);
  const [details, setDetails] = useState({});
  const [ticked, setTicked] = useState([]);
  const [ach, setAch] = useState(EMPTY_ACH);
  const [file, setFile] = useState(null);
  const [fileKey, setFileKey] = useState(0); // a new key empties the file picker after an upload
  const [credit, setCredit] = useState('');
  const [allowed, setAllowed] = useState(false);
  const [wikiTerm, setWikiTerm] = useState('');
  const [wiki, setWiki] = useState(null);
  const [staffEmail, setStaffEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  function applyProfile(res, st, ch) {
    if (res.error) { setError(friendlyError(res.error)); return; }
    setProfile(res);
    setDetails(Object.fromEntries(res.facilities.map((f) => [f.facility, f.detail ?? ''])));
    setTicked(res.levels ? (res.levels.hand ?? res.levels.now) : []);
    if (st) setStaff(st.staff);
    if (ch) setChanges(ch.changes);
  }

  async function refresh(id = schoolId) {
    const [res, st, ch] = await Promise.all([loadProfile(supabase, id), isAdmin ? loadStaff(supabase, id) : null, loadChanges(supabase, id)]);
    applyProfile(res, st, ch);
  }

  useEffect(() => {
    if (isAdmin) {
      loadChanges(supabase, null, 20).then((r) => { if (r.error) setError(friendlyError(r.error)); else setRecent(r.changes); });
    } else if (userId) {
      loadMySchools(supabase, userId).then((r) => {
        if (r.error) { setError(friendlyError(r.error)); return; }
        setMine(r.schools);
        if (r.schools.length === 1) setSchoolId(r.schools[0].id);
      });
    }
  }, [isAdmin, userId]);

  useEffect(() => {
    if (!schoolId) return;
    Promise.all([loadProfile(supabase, schoolId), isAdmin ? loadStaff(supabase, schoolId) : null, loadChanges(supabase, schoolId)])
      .then(([res, st, ch]) => applyProfile(res, st, ch));
  }, [schoolId, isAdmin]);

  async function act(fn, done) {
    setBusy(true); setError(''); setNotice('');
    const res = await fn();
    setBusy(false);
    if (res?.error) { setError(friendlyError(res.error)); return false; }
    if (done) setNotice(done);
    await refresh();
    if (isAdmin && !schoolId) setRecent((await loadChanges(supabase, null, 20)).changes);
    return true;
  }

  async function search(e) {
    e.preventDefault();
    setError('');
    const r = await findSchools(supabase, term);
    if (r.error) setError(friendlyError(r.error)); else setResults(r.schools);
  }

  function open(id) {
    setSchoolId(id); setProfile(null); setNotice(''); setError(''); setWiki(null); setAch(EMPTY_ACH); setFile(null); setCredit(''); setAllowed(false);
  }

  async function undo(c) {
    setBusy(true); setError(''); setNotice('');
    const res = await revertChange(supabase, c.id);
    setBusy(false);
    if (res.error) { setError(friendlyError(res.error)); return; }
    setNotice(`Undone: ${describeChange(c)}.`);
    if (schoolId) await refresh(); else setRecent((await loadChanges(supabase, null, 20)).changes);
  }

  const school = profile?.school;
  const has = (key) => profile?.facilities.find((f) => f.facility === key);

  return (
    <div className="bg-white text-gray-900 border border-gray-200 rounded-xl shadow-sm p-6" data-testid="profiles-panel">
      <h2 className="text-lg font-bold text-gray-900 mb-1">School profiles</h2>
      <p className="text-sm text-gray-600 mb-4">
        The levels, photo, facilities and achievements parents see on a school&apos;s page. Changes show at once, and every change is
        recorded{isAdmin ? '; you can undo any of them.' : ' (Kidscover can see and undo them).'}
      </p>
      {error && <p data-testid="profile-error" className="text-sm font-bold text-red-700 bg-red-50 border border-red-200 rounded p-3 mb-3">{error}</p>}
      {notice && <p data-testid="profile-notice" className="text-sm font-bold text-green-700 bg-green-50 border border-green-200 rounded p-3 mb-3">{notice}</p>}

      {!isAdmin && mine.length === 0 && !error && <p data-testid="profile-none" className="text-sm text-gray-600">No school is linked to your account yet. Ask Kidscover to add you as staff.</p>}
      {!isAdmin && mine.length > 1 && (
        <select data-testid="profile-mine" value={schoolId ?? ''} onChange={(e) => open(e.target.value || null)} className="border border-gray-300 rounded px-3 py-2 text-sm text-black mb-4">
          <option value="">Choose a school</option>
          {mine.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      )}

      {isAdmin && !schoolId && (
        <>
          <form className="flex gap-2 mb-3" onSubmit={search}>
            <input data-testid="profile-search" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Find a school by name or area"
              className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm text-black" />
            <button type="submit" data-testid="profile-search-go" className={`${btn} bg-blue-600 text-white`}>Find</button>
          </form>
          <div className="space-y-1 mb-5">
            {results.map((s) => (
              <button key={s.id} data-testid={`profile-result-${s.id}`} onClick={() => open(s.id)} className="block w-full text-left px-3 py-2 rounded hover:bg-gray-100 text-sm">
                <span className="font-bold">{s.name}</span> <span className="text-gray-500">{s.address}</span>
                {s.is_hidden && <span className="ml-2 text-xs font-bold text-gray-600 bg-gray-200 px-1.5 rounded">hidden</span>}
                {s.category && s.category !== 'school' && <span className="ml-2 text-xs font-bold text-amber-800 bg-amber-100 px-1.5 rounded">{s.category.replace('_', '-')}</span>}
              </button>
            ))}
          </div>
          <h3 className="font-bold text-gray-900 mb-2">Recent changes by schools and admins</h3>
          <ChangeList changes={recent} withSchool isAdmin onUndo={undo} busy={busy} />
        </>
      )}

      {schoolId && !school && !error && <p className="text-sm text-gray-500">Loading...</p>}
      {school && (
        <div data-testid="profile-editor">
          <div className="flex justify-between items-start gap-3 mb-4">
            <div>
              <h3 data-testid="profile-school-name" className="text-xl font-black text-gray-900">{school.name}</h3>
              <p className="text-xs text-gray-600">{school.address}</p>
            </div>
            {isAdmin && <button data-testid="profile-back" onClick={() => { setSchoolId(null); setProfile(null); }} className={`${btn} bg-gray-200 text-gray-800`}>Back to all schools</button>}
          </div>

          {/* ---- levels ---- */}
          <section className="mb-6">
            <h4 className="font-bold mb-2">Levels</h4>
            {profile.levelsError ? <p data-testid="levels-error" className="text-sm text-red-700">{profile.levelsError}</p> : (
              <>
                <p data-testid="levels-now" className="text-sm">Parents see: <span className="font-bold">{levelsText(profile.levels.now)}</span></p>
                <p data-testid="levels-source" className="text-xs text-gray-600 mb-2">{levelsSourceText(profile.levels)}</p>
                <div className="flex flex-wrap gap-x-4 gap-y-1 mb-2">
                  {LEVEL_ORDER.map((l) => (
                    <label key={l} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" data-testid={`level-${l}`} checked={ticked.includes(l)} disabled={busy}
                        onChange={(e) => setTicked((t) => (e.target.checked ? [...t, l] : t.filter((x) => x !== l)))} />
                      {LEVEL_NAMES[l]}
                    </label>
                  ))}
                </div>
                <p className="text-xs text-gray-600 mb-2">Saving replaces the automatic levels. Use it when they are missing or wrong.</p>
                <div className="flex gap-2">
                  <button data-testid="levels-save" disabled={busy || !ticked.length} onClick={() => act(() => setLevels(supabase, school.id, ticked), `Levels saved: ${levelsText(LEVEL_ORDER.filter((l) => ticked.includes(l)))}.`)}
                    className={`${btn} bg-blue-600 text-white`}>Save levels</button>
                  {profile.levels.hand && <button data-testid="levels-auto" disabled={busy} onClick={() => act(() => setLevels(supabase, school.id, null), 'Levels are worked out automatically again.')}
                    className={`${btn} bg-gray-200 text-gray-800`}>Back to automatic</button>}
                </div>
              </>
            )}
          </section>

          {/* ---- photo ---- */}
          <section className="mb-6">
            <h4 className="font-bold mb-2">Photo</h4>
            {school.photo_url ? (
              <div className="mb-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img data-testid="profile-photo" src={school.photo_url} alt={`Photo of ${school.name}`} className="max-h-48 rounded border border-gray-200" />
                <p data-testid="profile-photo-credit" className="text-xs text-gray-600 mt-1">
                  {photoCredit(school)}{school.photo_page_url && <> (<a className="underline" href={school.photo_page_url} target="_blank" rel="noreferrer noopener">source</a>)</>}
                </p>
                <button data-testid="photo-remove" disabled={busy} onClick={() => act(() => removePhoto(supabase, school.id), 'Photo removed. Parents now see the drawn school.')} className={`${btn} bg-gray-200 text-gray-800 mt-2`}>Remove photo</button>
              </div>
            ) : <p data-testid="profile-no-photo" className="text-sm text-gray-600 mb-2">No photo yet. Parents see a drawing of a school instead.</p>}
            <div className="border border-gray-200 rounded p-3 mb-2 bg-gray-50">
              <p className="text-sm font-bold mb-1">Upload a photo of the school</p>
              <input key={fileKey} data-testid="photo-file" type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-sm" />
              <input data-testid="photo-credit" value={credit} onChange={(e) => setCredit(e.target.value)} placeholder="Credit, e.g. the photographer (optional)"
                className="block w-full border border-gray-300 rounded px-2 py-1 text-sm text-black mt-2" />
              <label className="flex items-start gap-2 text-xs text-gray-700 mt-2">
                <input data-testid="photo-permission" type="checkbox" checked={allowed} onChange={(e) => setAllowed(e.target.checked)} />
                The school owns this photo, or has permission to publish it on Kidscover.
              </label>
              <button data-testid="photo-upload" disabled={busy || !file || !allowed} onClick={() => act(() => uploadPhoto(supabase, school.id, file, credit), 'Photo uploaded. Parents see it now.').then((ok) => { if (ok) { setFile(null); setAllowed(false); setFileKey((k) => k + 1); } })}
                className={`${btn} bg-blue-600 text-white mt-2`}>Upload and use</button>
            </div>
            <div className="border border-gray-200 rounded p-3 bg-gray-50">
              <p className="text-sm font-bold mb-1">Or find a free-licensed photo on Wikimedia Commons</p>
              <div className="flex gap-2">
                <input data-testid="wiki-term" value={wikiTerm || school.name} onChange={(e) => setWikiTerm(e.target.value)} className="flex-1 border border-gray-300 rounded px-2 py-1 text-sm text-black" />
                <button data-testid="wiki-search" disabled={busy} onClick={async () => { setError(''); const r = await searchWikimedia((u) => fetch(u), wikiTerm || school.name); if (r.error) setError(friendlyError(r.error)); setWiki(r.photos); }}
                  className={`${btn} bg-gray-200 text-gray-800`}>Search</button>
              </div>
              {wiki && wiki.length === 0 && <p data-testid="wiki-none" className="text-xs text-gray-600 mt-2">No free photos found. Try another name, or upload one.</p>}
              {wiki && wiki.length > 0 && (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mt-3">
                  {wiki.map((p, i) => (
                    <div key={p.url} data-testid={`wiki-photo-${i}`} className="text-xs">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={p.url} alt={p.title} className="w-full h-28 object-cover rounded border border-gray-200" />
                      <p className="mt-1 font-bold break-words">{p.title}</p>
                      <p className="text-gray-600">{p.credit}, {p.licence}</p>
                      <a className="underline text-blue-700" href={p.pageUrl} target="_blank" rel="noreferrer noopener">Check it on Commons</a>
                      <button data-testid={`wiki-use-${i}`} disabled={busy} onClick={() => act(() => chooseWikimediaPhoto(supabase, school.id, p), 'Photo saved, with its credit and licence.').then((ok) => { if (ok) setWiki(null); })}
                        className={`${btn} bg-blue-600 text-white block mt-1`}>Use this photo</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          {/* ---- facilities ---- */}
          <section className="mb-6">
            <h4 className="font-bold mb-2">Facilities</h4>
            <div className="grid md:grid-cols-2 gap-2">
              {FACILITIES.map((f) => {
                const row = has(f.key);
                const needsDetail = f.detail === 'required';
                return (
                  <div key={f.key} className="text-sm border border-gray-100 rounded p-2">
                    <label className="flex items-center gap-2">
                      <input type="checkbox" data-testid={`fac-${f.key}`} checked={!!row} disabled={busy || (needsDetail && !row && !details[f.key])}
                        onChange={(e) => act(() => setFacility(supabase, school.id, f.key, e.target.checked, details[f.key]), `${f.label}: ${e.target.checked ? 'added' : 'removed'}.`)} />
                      <span className="font-bold">{f.label}</span>
                      {row && <span className="text-xs text-gray-500">({SOURCE_LABELS[row.source] ?? row.source})</span>}
                    </label>
                    {(row || needsDetail) && (
                      <div className="flex gap-2 mt-1 ml-6">
                        <input data-testid={`fac-detail-${f.key}`} value={details[f.key] ?? ''} onChange={(e) => setDetails((d) => ({ ...d, [f.key]: e.target.value }))}
                          placeholder={f.placeholder ?? 'Detail (optional), e.g. 25 m pool'} className="flex-1 border border-gray-300 rounded px-2 py-1 text-xs text-black" />
                        <button data-testid={`fac-save-${f.key}`} disabled={busy || (!row && !needsDetail)}
                          onClick={() => act(() => setFacility(supabase, school.id, f.key, true, details[f.key]), `${f.label} saved.`)} className={`${btn} bg-gray-200 text-gray-800 text-xs`}>{row ? 'Save' : 'Add'}</button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          {/* ---- achievements ---- */}
          <section className="mb-6">
            <h4 className="font-bold mb-2">Achievements</h4>
            {profile.achievements.length === 0 && <p className="text-sm text-gray-600 mb-2">None yet.</p>}
            <ul className="space-y-2 mb-3">
              {profile.achievements.map((a) => (
                <li key={a.id} data-testid={`ach-${a.id}`} className="text-sm border border-gray-100 rounded p-2 flex justify-between gap-3">
                  <div>
                    <span className="font-bold">{kindLabel(a.kind)}{a.year ? `, ${a.year}` : ''}:</span> {a.text}
                    <span className="text-xs text-gray-500"> ({SOURCE_LABELS[a.source] ?? a.source}{a.source_url ? <>, <a className="underline" href={a.source_url} target="_blank" rel="noreferrer noopener">link</a></> : null})</span>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <button data-testid={`ach-edit-${a.id}`} onClick={() => setAch({ id: a.id, kind: a.kind, text: a.text, year: a.year ?? '', url: a.source_url ?? '' })} className={`${btn} bg-gray-200 text-gray-800 text-xs`}>Edit</button>
                    <button data-testid={`ach-delete-${a.id}`} disabled={busy} onClick={() => act(() => deleteAchievement(supabase, a.id), 'Achievement deleted.')} className={`${btn} bg-gray-200 text-gray-800 text-xs`}>Delete</button>
                  </div>
                </li>
              ))}
            </ul>
            <div className="border border-gray-200 rounded p-3 bg-gray-50 grid gap-2">
              <p className="text-sm font-bold">{ach.id ? 'Edit achievement' : 'Add an achievement'}</p>
              <select data-testid="ach-kind" value={ach.kind} onChange={(e) => setAch((x) => ({ ...x, kind: e.target.value }))} className="border border-gray-300 rounded px-2 py-1 text-sm text-black">
                {ACHIEVEMENT_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
              </select>
              <textarea data-testid="ach-text" value={ach.text} onChange={(e) => setAch((x) => ({ ...x, text: e.target.value }))} maxLength={300} rows={2}
                placeholder="e.g. 100% pass in ICSE; topper scored 98.6%" className="border border-gray-300 rounded px-2 py-1 text-sm text-black" />
              <div className="flex gap-2">
                <input data-testid="ach-year" value={ach.year} onChange={(e) => setAch((x) => ({ ...x, year: e.target.value.replace(/[^0-9]/g, '').slice(0, 4) }))} placeholder="Year"
                  className="w-24 border border-gray-300 rounded px-2 py-1 text-sm text-black" />
                <input data-testid="ach-url" value={ach.url} onChange={(e) => setAch((x) => ({ ...x, url: e.target.value }))} placeholder="Link to where it is published (optional)"
                  className="flex-1 border border-gray-300 rounded px-2 py-1 text-sm text-black" />
              </div>
              <div className="flex gap-2">
                <button data-testid="ach-save" disabled={busy} onClick={() => act(() => saveAchievement(supabase, school.id, ach), ach.id ? 'Achievement updated.' : 'Achievement added.').then((ok) => { if (ok) setAch(EMPTY_ACH); })}
                  className={`${btn} bg-blue-600 text-white`}>{ach.id ? 'Save changes' : 'Add'}</button>
                {ach.id && <button data-testid="ach-cancel" onClick={() => setAch(EMPTY_ACH)} className={`${btn} bg-gray-200 text-gray-800`}>Cancel</button>}
              </div>
            </div>
          </section>

          {/* ---- staff (Kidscover admins) ---- */}
          {isAdmin && (
            <section className="mb-6">
              <h4 className="font-bold mb-2">School staff who can edit this page</h4>
              {staff.length === 0 && <p className="text-sm text-gray-600 mb-2">Nobody yet.</p>}
              <ul className="space-y-1 mb-2">
                {staff.map((s) => (
                  <li key={s.userId} data-testid={`staff-${s.userId}`} className="text-sm flex justify-between items-center border border-gray-100 rounded p-2">
                    <span>{s.name} <span className="text-gray-500">{s.email}</span></span>
                    <button data-testid={`staff-remove-${s.userId}`} disabled={busy} onClick={() => act(() => removeStaff(supabase, school.id, s.userId), `${s.name} removed.`)} className={`${btn} bg-gray-200 text-gray-800 text-xs`}>Remove</button>
                  </li>
                ))}
              </ul>
              <div className="flex gap-2">
                <input data-testid="staff-email" value={staffEmail} onChange={(e) => setStaffEmail(e.target.value)} placeholder="Email they signed up with"
                  className="flex-1 border border-gray-300 rounded px-2 py-1 text-sm text-black" />
                <button data-testid="staff-add" disabled={busy} onClick={() => act(() => addStaff(supabase, school.id, staffEmail), `${staffEmail.trim()} can now edit this school.`).then((ok) => { if (ok) setStaffEmail(''); })}
                  className={`${btn} bg-blue-600 text-white`}>Add</button>
              </div>
            </section>
          )}

          {/* ---- history ---- */}
          <section>
            <h4 className="font-bold mb-2">Change history</h4>
            <ChangeList changes={changes} isAdmin={isAdmin} onUndo={undo} busy={busy} />
          </section>
        </div>
      )}
    </div>
  );
}

function ChangeList({ changes, withSchool = false, isAdmin, onUndo, busy }) {
  if (!changes.length) return <p className="text-sm text-gray-600">No changes yet.</p>;
  return (
    <ul className="space-y-1">
      {changes.map((c) => (
        <li key={c.id} data-testid={`change-${c.id}`} className={`text-sm flex justify-between items-center gap-3 border border-gray-100 rounded p-2 ${c.reverted_at ? 'opacity-60' : ''}`}>
          <span>
            {withSchool && <span className="font-bold">{c.schoolName}: </span>}
            {describeChange(c)}
            <span className="text-xs text-gray-500"> by {whoText(c)}, {when(c.changed_at)}{c.reverts ? ' (an undo)' : ''}{c.reverted_at ? ' (undone)' : ''}</span>
          </span>
          {isAdmin && canRevert(c) && <button data-testid={`undo-${c.id}`} disabled={busy} onClick={() => onUndo(c)} className={`${btn} bg-gray-200 text-gray-800 text-xs shrink-0`}>Undo</button>}
        </li>
      ))}
    </ul>
  );
}
