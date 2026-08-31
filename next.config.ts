import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Panel jest narzędziem pracy operatora, nie stroną publiczną: bez indeksowania,
  // bez optymalizacji obrazów pod CDN, za to z jawnymi błędami w konsoli.
  reactStrictMode: true,
  serverExternalPackages: ["pg"],
};

export default nextConfig;
