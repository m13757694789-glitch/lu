import type { NextConfig } from "next";
const config: NextConfig = {
  serverExternalPackages: ["archiver", "yauzl"],
  allowedDevOrigins: ["127.0.0.1", "localhost"],
};
export default config;
