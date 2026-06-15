# Public Release Checklist

## Code gates

- [x] Lint passes.
- [x] TypeScript typecheck passes.
- [x] Production build passes.
- [x] Fix nondeterministic alert delivery test.
- [x] Fix demo smoke test's expected creation status.
- [x] Keep viewer accounts read-only by restricting ingest-key creation to admins.
- [x] Add baseline browser security headers.
- [x] Override Next's vulnerable bundled PostCSS with patched PostCSS 8.5.15.
- [x] Update Settings and deployment documentation.
- [x] Run the full database-backed TypeScript suite with a role that can create scratch databases.
- [x] Run the production standalone end-to-end smoke test and secret-log scan.
- [ ] Run the same end-to-end smoke through the release container image.
- [ ] Confirm the exact release commit has green CI.

## Security and operations

- [ ] Claim the first admin account before exposing a fresh instance publicly.
- [ ] Confirm HTTPS is enforced by the reverse proxy.
- [ ] Confirm the reverse proxy overwrites, rather than appends untrusted values to, `X-Forwarded-For` and `X-Forwarded-Proto`.
- [ ] Back up both persistent volumes: PostgreSQL data and `/data/secrets.key`.
- [ ] Test database restore together with the matching `/data/secrets.key`.
- [ ] Confirm `DEMO_MODE` is unset on production instances.
- [ ] Review active vendor credentials and use the minimum provider scopes.
- [x] Confirm `npm audit --omit=dev` reports zero vulnerabilities.
- [ ] Replace the CSP's `unsafe-inline` allowances with nonce-based scripts and styles.

## Repository and release

- [ ] Require pull requests and passing `ci` and `e2e` checks on `main`.
- [ ] Prevent force pushes and branch deletion on `main`.
- [ ] Review the release tag diff from the previous version.
- [ ] Create the version tag only after CI is green.
- [ ] Verify the published image provenance and SBOM.
- [ ] Pull the published image by digest and run a post-release health check.
