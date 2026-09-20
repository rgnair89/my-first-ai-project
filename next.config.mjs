/** @type {import('next').NextConfig} */

// Headers every page of the Partner Portal is served with. They matter because this portal shows children's details:
//   * frame-ancestors / X-Frame-Options stop another site putting the portal in a hidden frame and stealing clicks;
//   * the content policy keeps scripts, styles and connections to Kidscover's own pages and Supabase, so a script that
//     somehow got in has nowhere to send anything;
//   * nosniff, the referrer policy and the permissions policy close the usual smaller holes.
// connect-src also allows Wikimedia Commons, which the photo picker searches from the browser.
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://*.supabase.co https://upload.wikimedia.org",
  "font-src 'self' data:",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://commons.wikimedia.org",
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  'upgrade-insecure-requests',
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
];

const nextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
