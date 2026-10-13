// Creates the key pair the server uses to sign push notifications.
// Usage: npm run vapid -- mailto:you@example.com
import { createECDH } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const subject = process.argv[2];
if (!subject || !/^(mailto:|https:\/\/)/.test(subject)) {
  console.error("Pass a contact for push services, e.g. npm run vapid -- mailto:you@example.com");
  process.exit(1);
}

const ecdh = createECDH("prime256v1");
ecdh.generateKeys();
const b64url = (buf) => buf.toString("base64url");
const vars = {
  VAPID_PUBLIC_KEY: b64url(ecdh.getPublicKey()),
  VAPID_PRIVATE_KEY: b64url(ecdh.getPrivateKey()),
  VAPID_SUBJECT: subject,
};

// .dev.vars is what local dev reads; keep any other lines already in it.
const kept = existsSync(".dev.vars")
  ? readFileSync(".dev.vars", "utf8").split("\n").filter((l) => l && !/^VAPID_/.test(l))
  : [];
writeFileSync(".dev.vars", [...kept, ...Object.entries(vars).map(([k, v]) => `${k}=${v}`)].join("\n") + "\n");

console.log("Wrote VAPID keys to .dev.vars for local development.\n");
console.log("For the deployed app, store the same values as secrets:");
for (const k of Object.keys(vars)) console.log(`  npx wrangler secret put ${k}`);
console.log("\nKeep the private key secret, and keep it stable: changing it means everyone re-enables notifications.");
