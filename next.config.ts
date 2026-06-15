import type { NextConfig } from "next";

// React's development build needs eval() (Fast Refresh, error overlays,
// owner-stack reconstruction); its production build never evals. So allow
// 'unsafe-eval' in dev only - production keeps the strict policy.
const isDev = process.env.NODE_ENV !== "production";

const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "base-uri 'self'",
      "connect-src 'self'",
      "font-src 'self' data:",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "img-src 'self' data: blob:",
      "object-src 'none'",
      `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
      "style-src 'self' 'unsafe-inline'",
    ].join("; "),
  },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=()" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
  // The Products and Coding pages merged into the one ROI tab (spec 10 page
  // 3); old links keep working. Query strings (the global date range) are
  // forwarded automatically. Detail routes (/products/:id) are untouched.
  async redirects() {
    return [
      { source: "/products", destination: "/roi", permanent: false },
      { source: "/tools", destination: "/roi", permanent: false },
    ];
  },
};

export default nextConfig;
