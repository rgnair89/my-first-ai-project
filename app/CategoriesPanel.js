'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/utils/supabase';
import {
  VIEWS, loadPlaces, loadCounts, setCategory, choicesFor, whyText, movedText, friendlyError,
} from './categories-admin';

export default function CategoriesPanel() {
  const [view, setView] = useState('after_school');
  const [search, setSearch] = useState('');
  const [typed, setTyped] = useState('');
  const [places, setPlaces] = useState([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [counts, setCounts] = useState({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busyId, setBusyId] = useState(null);

  function applyList(res, counted, more = false) {
    if (res.error) { setError(friendlyError(res.error)); return; }
    setError('');
    setPlaces((old) => (more ? [...old, ...res.places] : res.places));
    setHasMore(res.hasMore);
    if (counted) setCounts(counted);
  }

  useEffect(() => {
    Promise.all([loadPlaces(supabase, 'after_school'), loadCounts(supabase)]).then(([res, c]) => applyList(res, c));
  }, []);

  async function show(v, term = search) {
    setView(v);
    setSearch(term);
    setPage(0);
    setNotice('');
    applyList(await loadPlaces(supabase, v, term), await loadCounts(supabase));
  }

  async function more() {
    const next = page + 1;
    setPage(next);
    applyList(await loadPlaces(supabase, view, search, next), null, true);
  }

  async function move(p, choice) {
    setBusyId(p.id);
    setError('');
    setNotice('');
    const res = await setCategory(supabase, p, choice);
    setBusyId(null);
    if (res.error) { setError(friendlyError(res.error)); return; }
    setNotice(movedText(p, choice));
    setPage(0);
    applyList(await loadPlaces(supabase, view, search), await loadCounts(supabase));
  }

  return (
    <div className="bg-white text-gray-900 border border-gray-200 rounded-xl shadow-sm p-6" data-testid="categories-panel">
      <h2 className="text-lg font-bold text-gray-900 mb-1">Categories</h2>
      <p className="text-sm text-gray-600 mb-4">
        Parents see Schools first; after-school classes and colleges have their own lists, and hidden places are not shown at all.
        Rules sort every place by its name and Google&apos;s type. Move any place that is in the wrong list: your choice stays until you press Automatic.
      </p>

      <div className="flex flex-wrap gap-2 mb-3">
        {VIEWS.map((v) => (
          <button key={v.key} data-testid={`cview-${v.key}`} onClick={() => show(v.key)}
            className={`px-3 py-1.5 rounded-lg font-bold text-sm ${view === v.key ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}>
            {v.label} ({counts[v.key] ?? 0})
          </button>
        ))}
      </div>

      <form className="flex gap-2 mb-4" onSubmit={(e) => { e.preventDefault(); show(view, typed); }}>
        <input data-testid="category-search" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Search by name or area"
          className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm text-black" />
        <button type="submit" data-testid="category-search-go" className="px-4 py-2 rounded-lg text-sm font-bold bg-gray-200 text-gray-800 hover:bg-gray-300">Search</button>
      </form>

      {!!notice && <p data-testid="category-notice" className="text-sm text-green-700 font-bold mb-3">{notice}</p>}
      {!!error && <p data-testid="category-error" className="text-sm text-red-600 font-bold mb-3">{error}</p>}

      {places.length === 0 && !error ? (
        <p className="text-gray-500 italic text-sm">Nothing here.</p>
      ) : (
        <div className="space-y-3">
          {places.map((p) => (
            <div key={p.id} data-testid={`place-${p.id}`} className="border border-gray-200 rounded-lg p-4 bg-gray-50 flex flex-wrap justify-between gap-3">
              <div className="min-w-0">
                <h3 className="font-bold text-gray-900">{p.name}</h3>
                {!!p.address && <p className="text-xs text-gray-600">{p.address}</p>}
                <p data-testid={`why-${p.id}`} className="text-xs text-gray-500 mt-1">{whyText(p)}</p>
              </div>
              <div className="flex flex-wrap items-start gap-2">
                {choicesFor(p).map((c) => (
                  <button key={c.key} data-testid={`move-${p.id}-${c.key}`} disabled={!!busyId} onClick={() => move(p, c.key)}
                    className={`px-3 py-1.5 rounded text-sm font-bold disabled:opacity-50 ${c.key === 'hidden' ? 'bg-gray-200 text-gray-800' : c.key === 'auto' ? 'border border-gray-400 text-gray-700' : 'bg-blue-600 text-white'}`}>
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {hasMore && (
        <button data-testid="category-more" onClick={more} className="mt-4 px-4 py-2 rounded-lg text-sm font-bold border border-gray-400 text-gray-700">Show more</button>
      )}
    </div>
  );
}
