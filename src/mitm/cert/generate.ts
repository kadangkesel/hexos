import { generateRootCA, loadRootCA, generateLeafCert } from "./rootCA.ts";

/** Generate Root CA certificate (one-time setup) */
export async function generateCert() {
  return await generateRootCA();
}

/** Get certificate for a specific domain (dynamic generation via SNI) */
export function getCertForDomain(domain: string): { key: string; cert: string } | null {
  try {
    const rootCA = loadRootCA();
    return generateLeafCert(domain, rootCA);
  } catch (error: any) {
    console.error(`Failed to generate cert for ${domain}:`, error.message);
    return null;
  }
}
