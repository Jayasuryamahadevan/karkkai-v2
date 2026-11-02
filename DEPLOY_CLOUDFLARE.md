# Cloudflare deployment

Karkkai is deployed as a static-asset Cloudflare Worker. The PDF Studio and Python API are intentionally excluded from this free-tier deployment.

## Runtime

- Static assets: `web/`
- Worker entry point: `worker.js`
- URL: `https://karkkai-v2.<your-workers-subdomain>.workers.dev`
- No database, R2 bucket, Python runtime, or paid Cloudflare service is required.

## One-time account setup

1. In Cloudflare, create an API token with **Workers Scripts: Edit** and **Account Settings: Read** permissions, scoped to the target account.
2. In the GitHub repository, open **Settings → Secrets and variables → Actions**.
3. Add repository secrets:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
4. Merge the deployment changes into `main`. The GitHub Actions workflow deploys automatically. You can also run it manually from **Actions → Deploy Karkkai to Cloudflare Workers → Run workflow**.

## Feature scope

- Tamil dictionary and word discovery: browser-local datasets.
- Spell checking: browser-local engine.
- Translation and voice: browser/browser-supported and external online engines; internet access and provider availability may be required.
- PDF compression and editing: disabled in this deployment because the original feature requires the Python backend and native PDF tooling.

## Local verification

```bash
npx wrangler@4 deploy --dry-run --config wrangler.toml
```

The production deployment requires the two GitHub Actions secrets above. Never commit API tokens to this repository.
