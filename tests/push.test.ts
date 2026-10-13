import { describe, expect, it } from "vitest";
import { createECDH, createPublicKey, verify, randomBytes } from "node:crypto";
// @ts-expect-error -- no types published
import ece from "http_ece";
import { b64urlDecode, b64urlEncode, encryptPayload, vapidAuthorization } from "../worker/push";

describe("web push", () => {
  it("produces aes128gcm payloads a browser-side decrypter can read", async () => {
    const browser = createECDH("prime256v1");
    browser.generateKeys();
    const authSecret = randomBytes(16);
    const target = {
      endpoint: "https://push.example.com/abc",
      p256dh: b64urlEncode(browser.getPublicKey()),
      auth: b64urlEncode(authSecret),
    };
    const message = JSON.stringify({ title: "Bins!", body: "Take the bins out 🗑️" });
    const body = await encryptPayload(target, new TextEncoder().encode(message));
    const plain = ece.decrypt(Buffer.from(body), {
      version: "aes128gcm",
      privateKey: browser,
      authSecret,
    });
    expect(plain.toString("utf8")).toBe(message);
  });

  it("signs a VAPID JWT that verifies with the public key", async () => {
    const server = createECDH("prime256v1");
    server.generateKeys();
    const vapid = {
      publicKey: b64urlEncode(server.getPublicKey()),
      privateKey: b64urlEncode(server.getPrivateKey()),
      subject: "mailto:family@example.com",
    };
    const header = await vapidAuthorization("https://fcm.googleapis.com/fcm/send/xyz", vapid);
    const [, jwt, k] = header.match(/^vapid t=([^,]+), k=(.+)$/)!;
    expect(k).toBe(vapid.publicKey);
    const [h, c, s] = jwt.split(".");
    const claims = JSON.parse(Buffer.from(b64urlDecode(c)).toString());
    expect(claims.aud).toBe("https://fcm.googleapis.com");
    const pub = server.getPublicKey();
    const key = createPublicKey({
      key: { kty: "EC", crv: "P-256", x: b64urlEncode(pub.subarray(1, 33)), y: b64urlEncode(pub.subarray(33)) },
      format: "jwk",
    });
    const ok = verify("sha256", Buffer.from(`${h}.${c}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(b64urlDecode(s)));
    expect(ok).toBe(true);
  });
});
