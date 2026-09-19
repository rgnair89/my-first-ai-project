'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/utils/supabase';
import { testDriveTimes, loadUsage, indiaToday, usageLine, minutesText } from './drive-admin';

export default function DriveTimesPanel() {
  const [usage, setUsage] = useState(null);
  const [usageError, setUsageError] = useState('');
  const [result, setResult] = useState(null);
  const [testing, setTesting] = useState(false);

  function applyUsage(res) {
    if (res.error) setUsageError('Drive-time limits are not set up yet: run the 20260919000700_drive_times.sql migration.');
    else { setUsageError(''); setUsage(res); }
  }

  useEffect(() => {
    loadUsage(supabase, indiaToday()).then(applyUsage);
  }, []);

  async function refresh() {
    applyUsage(await loadUsage(supabase, indiaToday()));
  }

  async function test() {
    setTesting(true);
    setResult(null);
    const res = await testDriveTimes(supabase);
    setResult(res);
    setTesting(false);
    await refresh();
  }

  return (
    <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6 mb-6" data-testid="drive-panel">
      <div className="flex justify-between items-start gap-4">
        <div>
          <h2 className="text-lg font-bold text-gray-900">Drive times (Google Routes)</h2>
          <p className="text-sm text-gray-600">Parents see drive times only when they ask. Each lookup covers up to 20 schools and Google bills per school.</p>
          {usage?.settings && (
            <p data-testid="drive-usage" className="text-sm text-gray-800 mt-2">
              {usageLine(usage.today, usage.settings)}. Limits: {usage.settings.per_user_daily_lookups} lookups per parent a day
              {usage.settings.enabled ? '' : ' (switched OFF)'}.
            </p>
          )}
          {usageError && <p data-testid="drive-usage-error" className="text-sm text-amber-800 mt-2">{usageError}</p>}
        </div>
        <button
          data-testid="drive-test"
          onClick={test}
          disabled={testing}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap"
        >
          {testing ? 'Testing...' : 'Test drive times'}
        </button>
      </div>
      {result && (
        <div data-testid="drive-result" className={`mt-4 text-sm rounded p-3 border ${result.ok ? 'bg-green-50 border-green-200 text-green-800' : 'bg-amber-50 border-amber-200 text-amber-900'}`}>
          <p className="font-bold">{result.message}</p>
          {!!result.detail && <p data-testid="drive-detail" className="mt-1 font-mono text-xs break-all">{result.detail}</p>}
          {result.ok && (
            <ul className="mt-2 list-disc ml-5">
              {result.results.map((r) => <li key={r.name}>{r.name}: {minutesText(r.time)}</li>)}
            </ul>
          )}
          <p className="text-xs mt-2 text-gray-600">The test uses a fixed point in Bandra Kurla Complex and one of your own lookups.</p>
        </div>
      )}
    </div>
  );
}
