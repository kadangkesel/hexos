import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Enable static export for standalone distribution
  // When NEXT_STATIC_EXPORT=true, build outputs to dashboard/out/ as pure HTML/CSS/JS
  ...(process.env.NEXT_STATIC_EXPORT === "true" ? { output: "export" } : {}),
};

export default nextConfig;
