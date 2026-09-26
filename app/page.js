'use client';

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/utils/supabase';
import SweepPanel from './SweepPanel';
import ReviewsPanel from './ReviewsPanel';
import EnquiriesPanel from './EnquiriesPanel';
import DriveTimesPanel from './DriveTimesPanel';
import SiteDataPanel from './SiteDataPanel';
import CategoriesPanel from './CategoriesPanel';
import SchoolProfilePanel from './SchoolProfilePanel';
import ApplicationsPanel from './ApplicationsPanel';
import SecurityPanel from './SecurityPanel';
import FeeFindingsPanel from './FeeFindingsPanel';
import { loadPendingCount } from './reviews-admin';
import { loadOpenCount } from './enquiries-admin';
import { loadMySchools } from './profiles-admin';
import { needsSecondStep, loadFactors, signInStep, friendlyError as securityError, cleanCode } from './security-admin';

export default function RootRouting() {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [step, setStep] = useState({ checked: false, needed: false, factorId: null, level: null });

  // Auth Form State
  const [isSignUp, setIsSignUp] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  const afterSignIn = useCallback((s) => {
    if (!s) { setProfile(null); setStep({ checked: false, needed: false, factorId: null, level: null }); return Promise.resolve(); }
    return Promise.all([
      supabase.from('profiles').select('*').eq('id', s.user.id).single(),
      needsSecondStep(supabase.auth),
      loadFactors(supabase.auth),
    ]).then(([p, need, factors]) => {
      setProfile(p.data);
      setStep({
        checked: true,
        needed: !!need.needed,
        level: need.level ?? null,
        factorId: factors.factors.find((f) => f.status === 'verified')?.id ?? null,
      });
    });
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session: s } }) => { setSession(s); return afterSignIn(s); });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => { setSession(s); afterSignIn(s); });
    return () => subscription.unsubscribe();
  }, [afterSignIn]);

  async function handleAuth(e) {
    e.preventDefault();
    setLoading(true);
    setMessage('');

    if (isSignUp) {
      // Pass the names as metadata so the DB trigger can read them
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            first_name: firstName,
            last_name: lastName
          },
          emailRedirectTo: window.location.origin
        }
      });
      if (error) setMessage(error.message);
      else setMessage('Registration successful! Please check your email to verify your account.');
    } else {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password
      });
      if (error) setMessage(error.message);
    }
    setLoading(false);
  }

  if (!session) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-4">
        <div className="bg-white text-gray-900 p-8 rounded-xl shadow-sm border border-gray-200 w-full max-w-md">
          <h1 className="text-3xl font-black text-gray-900 mb-6 text-center">Kidscover</h1>

          <form onSubmit={handleAuth} className="mb-6">
            {isSignUp && (
              <div className="flex gap-4 mb-4">
                <div className="flex-1">
                  <label className="block text-xs font-bold text-gray-500 mb-2">FIRST NAME</label>
                  <input
                    type="text"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg p-3 text-black"
                    required={isSignUp}
                  />
                </div>
                <div className="flex-1">
                  <label className="block text-xs font-bold text-gray-500 mb-2">LAST NAME</label>
                  <input
                    type="text"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg p-3 text-black"
                    required={isSignUp}
                  />
                </div>
              </div>
            )}

            <label className="block text-xs font-bold text-gray-500 mb-2">EMAIL ADDRESS</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full border border-gray-300 rounded-lg p-3 mb-4 text-black"
              required
            />

            <label className="block text-xs font-bold text-gray-500 mb-2">PASSWORD</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full border border-gray-300 rounded-lg p-3 mb-6 text-black"
              required
            />

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-blue-600 text-white font-bold p-3 rounded-lg hover:bg-blue-700 disabled:opacity-50 mb-4"
            >
              {loading ? 'Processing...' : (isSignUp ? 'Create Account' : 'Log In')}
            </button>

            <button
              type="button"
              onClick={() => {
                setIsSignUp(!isSignUp);
                setMessage('');
              }}
              className="w-full text-sm text-blue-600 font-bold hover:underline"
            >
              {isSignUp ? 'Already have an account? Log in' : "Don't have an account? Sign up"}
            </button>
          </form>

          {message && <p className={`text-sm text-center font-bold mb-6 ${message.includes('successful') ? 'text-green-600' : 'text-red-600'}`}>{message}</p>}
        </div>
      </div>
    );
  }

  if (step.needed) return <SecondStep factorId={step.factorId} onDone={() => afterSignIn(session)} />;

  if (profile?.role === 'admin') return <AdminWebDashboard profile={profile} level={step.level} />;
  if (profile?.role === 'school_admin') return <SchoolStaffDashboard profile={profile} userId={session.user.id} level={step.level} />;
  return <ParentWebDashboard profile={profile} />;
}

// The code from an authenticator app, asked for once per sign-in when the account has two-step sign-in set up.
function SecondStep({ factorId, onDone }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function verify(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const res = await signInStep(supabase.auth, factorId, code);
    setBusy(false);
    if (res.error) { setError(securityError(res.error)); return; }
    onDone();
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <form onSubmit={verify} className="bg-white text-gray-900 p-8 rounded-xl shadow-sm border border-gray-200 w-full max-w-sm" data-testid="second-step">
        <h1 className="text-xl font-black mb-2">One more step</h1>
        <p className="text-sm text-gray-600 mb-4">Open your authenticator app and type the 6-digit code for Kidscover.</p>
        <input data-testid="second-step-code" value={code} onChange={(e) => setCode(cleanCode(e.target.value))} inputMode="numeric"
          placeholder="123456" className="w-full border border-gray-300 rounded-lg p-3 text-black text-center tracking-widest text-lg" />
        {error && <p data-testid="second-step-error" className="text-sm font-bold text-red-600 mt-3">{error}</p>}
        <button type="submit" data-testid="second-step-go" disabled={busy} className="w-full bg-blue-600 text-white font-bold p-3 rounded-lg mt-4 disabled:opacity-50">
          {busy ? 'Checking...' : 'Continue'}
        </button>
        <button type="button" onClick={() => supabase.auth.signOut()} className="w-full text-sm text-gray-500 font-bold mt-3 hover:underline">Sign out</button>
      </form>
    </div>
  );
}

function Tabs({ tabs, active, onPick }) {
  return (
    <div className="flex flex-wrap gap-3 mb-6">
      {tabs.map((t) => (
        <button key={t.key} data-testid={`tab-${t.key}`} onClick={() => onPick(t.key)}
          className={`px-4 py-2 rounded-lg font-bold text-sm ${active === t.key ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-700'}`}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

// A school's own staff: their school's page, their enquiries, their applications, and their own sign-in security.
function SchoolStaffDashboard({ profile, userId, level }) {
  const [tab, setTab] = useState('school');
  const [schoolIds, setSchoolIds] = useState(null);

  useEffect(() => { loadMySchools(supabase, userId).then((r) => setSchoolIds((r.schools ?? []).map((s) => s.id))); }, [userId]);

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-2xl font-bold text-black">Kidscover for Schools</h1>
          <span className="text-xs text-blue-700 font-bold">{profile?.first_name} {profile?.last_name} | {profile?.email}</span>
        </div>
        <button onClick={() => supabase.auth.signOut()} className="text-gray-500 font-bold hover:text-black">Sign Out</button>
      </div>
      <Tabs
        tabs={[
          { key: 'school', label: 'Your school page' },
          { key: 'enquiries', label: 'Enquiries' },
          { key: 'applications', label: 'Applications' },
          { key: 'security', label: 'Security' },
        ]}
        active={tab}
        onPick={setTab}
      />
      {tab === 'school' && <SchoolProfilePanel mode="staff" userId={userId} />}
      {tab === 'enquiries' && <EnquiriesPanel mode="staff" />}
      {tab === 'applications' && <ApplicationsPanel mode="staff" schoolIds={schoolIds} />}
      {tab === 'security' && <SecurityPanel level={level} />}
    </div>
  );
}

function ParentWebDashboard({ profile }) {
  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-2xl font-bold text-black">Parent Dashboard</h1>
        <button onClick={() => supabase.auth.signOut()} className="text-gray-500 font-bold hover:text-black">Sign Out</button>
      </div>
      <div className="bg-green-50 border border-green-200 p-4 rounded-lg inline-block">
        <span className="text-green-700 font-bold text-sm">
          Welcome, {profile?.first_name} {profile?.last_name} | {profile?.email} (Verified)
        </span>
      </div>
      <p className="text-sm text-gray-600 mt-4">Kidscover for parents is the phone app. This page is for schools and Kidscover staff.</p>
    </div>
  );
}

function AdminWebDashboard({ profile, level }) {
  const [activeSubTab, setActiveSubTab] = useState('applications');
  const [openEnquiries, setOpenEnquiries] = useState(0);
  const [pendingReviews, setPendingReviews] = useState(0);

  const counts = useCallback(() => {
    loadPendingCount(supabase).then(setPendingReviews);
    loadOpenCount(supabase).then(setOpenEnquiries);
  }, []);
  useEffect(() => {
    loadPendingCount(supabase).then(setPendingReviews);
    loadOpenCount(supabase).then(setOpenEnquiries);
  }, []);

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-2xl font-bold text-black">Partner Portal</h1>
          <span className="text-xs text-blue-700 font-bold">
            Admin: {profile?.first_name} {profile?.last_name} | Partner ID: {profile?.email} (Verified)
          </span>
        </div>
        <button onClick={() => supabase.auth.signOut()} className="text-gray-500 font-bold hover:text-black">Sign Out</button>
      </div>

      <SweepPanel />
      <DriveTimesPanel />

      <Tabs
        tabs={[
          { key: 'applications', label: 'Admission applications' },
          { key: 'enquiries', label: `Enquiries (${openEnquiries} need a reply)` },
          { key: 'reviews', label: `Parent reviews (${pendingReviews} waiting)` },
          { key: 'schooldata', label: 'School data' },
          { key: 'fees', label: 'Fees found on websites' },
          { key: 'categories', label: 'Categories' },
          { key: 'profiles', label: 'School profiles' },
          { key: 'security', label: 'Security' },
        ]}
        active={activeSubTab}
        onPick={setActiveSubTab}
      />

      {activeSubTab === 'applications' && <ApplicationsPanel mode="admin" />}
      {activeSubTab === 'enquiries' && <EnquiriesPanel onChanged={counts} />}
      {activeSubTab === 'reviews' && <ReviewsPanel onChanged={counts} />}
      {activeSubTab === 'schooldata' && <SiteDataPanel />}
      {activeSubTab === 'fees' && <FeeFindingsPanel />}
      {activeSubTab === 'categories' && <CategoriesPanel />}
      {activeSubTab === 'profiles' && <SchoolProfilePanel mode="admin" />}
      {activeSubTab === 'security' && <SecurityPanel isAdmin level={level} />}
    </div>
  );
}
