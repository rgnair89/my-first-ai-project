'use client';

import { useState, useEffect } from 'react';
import { supabase } from '@/utils/supabase';
import SweepPanel from './SweepPanel';
import ReviewsPanel from './ReviewsPanel';
import EnquiriesPanel from './EnquiriesPanel';
import DriveTimesPanel from './DriveTimesPanel';
import SiteDataPanel from './SiteDataPanel';
import { loadPendingCount } from './reviews-admin';
import { loadOpenCount } from './enquiries-admin';

export default function RootRouting() {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  
  // Auth Form State
  const [isSignUp, setIsSignUp] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  async function fetchProfile(userId) {
    const { data } = await supabase.from('profiles').select('*').eq('id', userId).single();
    setProfile(data);
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      if (session) fetchProfile(session.user.id);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      if (session) fetchProfile(session.user.id);
    });

    return () => subscription.unsubscribe();
  }, []);

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

  async function handleOAuthLogin(provider) {
    await supabase.auth.signInWithOAuth({
      provider: provider,
      options: { redirectTo: window.location.origin }
    });
  }

  if (!session) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-4">
        <div className="bg-white p-8 rounded-xl shadow-sm border border-gray-200 w-full max-w-md">
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

          <div className="flex items-center mb-6">
            <div className="flex-1 border-t border-gray-200"></div>
            <span className="px-4 text-xs font-bold text-gray-400">OR</span>
            <div className="flex-1 border-t border-gray-200"></div>
          </div>

          <button 
            onClick={() => handleOAuthLogin('google')}
            className="w-full border border-gray-300 text-gray-700 font-bold p-3 rounded-lg hover:bg-gray-50 flex justify-center items-center gap-2"
          >
            Continue with Google
          </button>
        </div>
      </div>
    );
  }

  if (profile?.role === 'admin') return <AdminWebDashboard profile={profile} />;
  return <ParentWebDashboard profile={profile} />;
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
    </div>
  );
}

function AdminWebDashboard({ profile }) {
  const [activeSubTab, setActiveSubTab] = useState('applications'); // 'applications' | 'enquiries' | 'reviews' | 'schooldata'
  const [applications, setApplications] = useState([]);
  const [openEnquiries, setOpenEnquiries] = useState(0);
  const [pendingReviews, setPendingReviews] = useState(0);

  useEffect(() => {
    fetchApplications();
    fetchOpenEnquiries();
    fetchPendingReviews();
  }, []);

  async function fetchPendingReviews() {
    setPendingReviews(await loadPendingCount(supabase));
  }

  async function fetchOpenEnquiries() {
    setOpenEnquiries(await loadOpenCount(supabase));
  }

  async function fetchApplications() {
    const { data } = await supabase.from('applications').select('*, schools(name)').order('created_at', { ascending: false });
    setApplications(data || []);
  }

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

      <div className="flex gap-4 mb-6">
        <button
          onClick={() => setActiveSubTab('applications')}
          className={`px-4 py-2 rounded-lg font-bold text-sm ${activeSubTab === 'applications' ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-700'}`}
        >
          Admissions Pipeline ({applications.length})
        </button>
        <button
          onClick={() => setActiveSubTab('enquiries')}
          className={`px-4 py-2 rounded-lg font-bold text-sm ${activeSubTab === 'enquiries' ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-700'}`}
        >
          Admissions Enquiries ({openEnquiries} need a reply)
        </button>
        <button
          onClick={() => setActiveSubTab('reviews')}
          className={`px-4 py-2 rounded-lg font-bold text-sm ${activeSubTab === 'reviews' ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-700'}`}
        >
          Parent Reviews ({pendingReviews} waiting)
        </button>
        <button
          onClick={() => setActiveSubTab('schooldata')}
          className={`px-4 py-2 rounded-lg font-bold text-sm ${activeSubTab === 'schooldata' ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-700'}`}
        >
          School Data
        </button>
      </div>

      {activeSubTab === 'schooldata' ? (
        <SiteDataPanel />
      ) : activeSubTab === 'reviews' ? (
        <ReviewsPanel onChanged={fetchPendingReviews} />
      ) : activeSubTab === 'applications' ? (
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden p-6">
          <h2 className="text-lg font-bold text-gray-900 mb-4">Submitted Applications</h2>
          {applications.length === 0 ? (
            <p className="text-gray-500 italic text-sm">No applications found in pipeline.</p>
          ) : (
            <div className="space-y-4">
              {applications.map((app) => (
                <div key={app.id} className="border border-gray-100 bg-gray-50 p-4 rounded-lg flex justify-between items-center">
                  <div>
                    <span className="text-xs font-bold text-amber-700 uppercase bg-amber-100 px-2 py-0.5 rounded">{app.status}</span>
                    <h3 className="font-bold text-gray-900 mt-1">{app.schools?.name}</h3>
                    <p className="text-xs text-gray-600">Applicant: {app.ward_first_name} {app.ward_last_name} | Grade: {app.grade_applied_for}</p>
                  </div>
                  <span className="text-xs text-gray-400">{new Date(app.created_at).toLocaleDateString()}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <EnquiriesPanel onChanged={fetchOpenEnquiries} />
      )}
    </div>
  );
}