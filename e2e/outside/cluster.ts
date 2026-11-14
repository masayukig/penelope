// The cluster's side of the A2A senders' checks, fake (e2e/README.md): the API
// server's TokenReview, and gated, which signs the assertions that stand in
// for the tokens it takes off, and publishes its keys.
import { generateKeyPairSync, sign } from "node:crypto";
import type http from "node:http";

export const KUBERNETES = "kubernetes.example.com";
export const GATED = "auth.example.com";
export const GATED_ISSUER = `https://${GATED}`;
/** The audience the senders' tokens are made for. */
export const AUDIENCE = "https://penelope.example.com";

export type Review = { at: string; caller: "backend" | "other"; outcome: string };

/**
 * The API server knows two ServiceAccount tokens: the sender's and a
 * stranger's. A review is answered only for the backend's own token.
 */
export function cluster(tokens: { backend: string; sender: string; stranger: string }) {
  const reviews: Review[] = [];
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwks = { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "e2e-1", use: "sig", alg: "EdDSA" }] };

  function tokenReview(request: http.IncomingMessage, body: string, response: http.ServerResponse): void {
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.method !== "POST" || request.url !== "/apis/authentication.k8s.io/v1/tokenreviews") return send(404, { kind: "Status", code: 404 });
    const caller = request.headers.authorization === `Bearer ${tokens.backend}` ? "backend" : "other";
    if (caller !== "backend") {
      reviews.push({ at: new Date().toISOString(), caller, outcome: "forbidden" });
      return send(401, { kind: "Status", code: 401 });
    }
    const { spec } = JSON.parse(body) as { spec: { token: string; audiences?: string[] } };
    const username = spec.token === tokens.sender ? "system:serviceaccount:e2e:claude" : spec.token === tokens.stranger ? "system:serviceaccount:e2e:stranger" : undefined;
    const audiences = (spec.audiences ?? [AUDIENCE]).filter((audience) => audience === AUDIENCE);
    const authenticated = username !== undefined && audiences.length > 0;
    reviews.push({ at: new Date().toISOString(), caller, outcome: authenticated ? username : "unauthenticated" });
    send(201, {
      apiVersion: "authentication.k8s.io/v1",
      kind: "TokenReview",
      status: authenticated ? { authenticated, user: { username }, audiences } : { authenticated: false, error: "invalid token" },
    });
  }

  function gatedKeys(request: http.IncomingMessage, response: http.ServerResponse): void {
    response.writeHead(request.url === "/__gated/jwks.json" ? 200 : 404, { "content-type": "application/json", "cache-control": "max-age=300" });
    response.end(JSON.stringify(request.url === "/__gated/jwks.json" ? jwks : { error: "not found" }));
  }

  /** What gated would put on a call of `subject` to `host`, for a minute. */
  function assertion(subject: string, host: string): string {
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const signed = `${part({ alg: "EdDSA", typ: "gated-assertion+jwt", kid: "e2e-1" })}.${part({ iss: GATED_ISSUER, aud: host, sub: subject, iat: now, exp: now + 60 })}`;
    return `${signed}.${sign(null, Buffer.from(signed), privateKey).toString("base64url")}`;
  }

  return { reviews, tokenReview, gatedKeys, assertion };
}
