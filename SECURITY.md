# Security Policy

Tokenturn handles vendor admin tokens and per-person usage data, so we take
reports seriously.

## Reporting a vulnerability

Email **[hi@flowengine.cloud](mailto:hi@flowengine.cloud)** with `SECURITY` in the
subject. Do **not** open a public GitHub issue for a security report.

Please include:

- What you found and where (file, endpoint, or feature).
- Steps to reproduce, or a proof of concept.
- The impact you think it has.

We aim to acknowledge within 3 business days and to agree on a disclosure
timeline with you. We'll credit reporters who want it once a fix ships.

## Supported versions

Tokenturn is self-hosted and ships as tagged GHCR images. Only the **latest
tagged release** receives security fixes - run the newest version. Images are
pinned by digest with a build-provenance attestation and an SPDX SBOM on each
GitHub release (`gh attestation verify`).

## Security model (what to keep in mind)

- **No proxy, no stored employee keys.** Tokenturn reads vendor admin APIs; it
  never sits between your apps and the models, and per-person keys are shown
  once and never saved or logged.
- **Vendor admin tokens are encrypted at rest** with the key in
  `/data/secrets.key`. Back it up with the database and restrict access - it
  decrypts every stored credential.
- **You operate the perimeter.** Enforce HTTPS at your reverse proxy, claim the
  first admin account before exposing a fresh instance, and ensure the proxy
  overwrites (not appends) `X-Forwarded-For` and `X-Forwarded-Proto`.
- **Enterprise (`ee/`) license checks** verify offline against a pinned Ed25519
  public key. The signing key never ships in this repo.

## Out of scope

- Findings that require a compromised host, stolen `secrets.key`, or an
  already-authenticated admin acting maliciously.
- Missing hardening on a deployment that ignores the items above or the
  `RELEASE_CHECKLIST.md`.
