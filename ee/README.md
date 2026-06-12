# Tokenturn Enterprise (`ee/`)

Everything in this directory is commercial - see [LICENSE](LICENSE). It ships
in the same repo and the same Docker image as the open-source app, locked
behind a license file issued per deal and verified **offline** against
FlowEngine's Ed25519 public key (pinned in `src/lib/license.ts`). No license
server, no phone-home. Locked features show one line:

> Enterprise feature - contact hi@flowengine.cloud

When a license expires the features lock again; every number and row recorded
while licensed stays readable.

## Features

| Feature | Key | Status |
|---|---|---|
| Okta sync - auto-invite on hire, auto-offboard on leave | `okta_sync` | shipped |
| Google Workspace roster sync | `google_workspace` | shipped |
| More admins | `more_admins` | shipped |
| Audit log - every sweep, every settings change, exportable | `audit_log` | shipped |
| Scheduled reports - monthly PDF email | `scheduled_reports` | shipped |
| Multi-org rollup | `multi_org` | roadmap (not in v0.1.0; license files may already grant it) |

## Issuing a license (FlowEngine-internal)

The signing key never ships. Generate one once:

```bash
node ee/scripts/keygen.mjs > license-signing-key.pem   # keep offline
```

(its public half is what `src/lib/license.ts` pins). Then per deal:

```bash
node ee/scripts/issue-license.mjs \
  --key license-signing-key.pem \
  --org "Acme Corp" \
  --expires 2027-06-30 \
  --features '*'              # or: okta_sync,audit_log,...
```

prints the license file JSON. The customer pastes it into Settings → License.
