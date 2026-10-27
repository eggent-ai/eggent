## Eggent v0.7.1 - Security Update

A security fix for the web server. Update if you run Eggent where anyone else can reach it.

### Highlights

- **Security: Next.js 15.5.28.** GHSA-2464-fhr4-w9xw: the image library behind Next.js's Image Optimization API (`/_next/image`) could run code on Linux with glibc, which the Docker image uses, without signing in. Next.js 15.5.28 pulls the fixed `sharp` 0.35.5.
- **The image optimizer is off.** Nothing in Eggent uses `next/image`, so `images.unoptimized` is set: `/_next/image` converts nothing.
- **Context windows from the provider.** A provider added by the agent gives each model the context window its own `/models` endpoint reports; one that reports only ids keeps 128k.
- **Fresh usage figures.** The sidebar meter asks for fresh numbers when a page opens or the tab comes back.

### Upgrade Notes

- Migration: none.
- Docker: pull `ghcr.io/eggent-ai/eggent:0.7.1` (or `latest`) and recreate the container. From source: `npm install`, then rebuild.

### Links

- Full notes: `docs/releases/0.7.1-security-update.md`
- README: `README.md`
