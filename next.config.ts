import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
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
