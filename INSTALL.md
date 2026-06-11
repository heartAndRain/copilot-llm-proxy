# Installing `cllmp` on another machine

Install `cllmp` on as many machines as you like. Each machine runs its own
proxy bound to `127.0.0.1` and uses your local GitHub Copilot account.

Two flavors depending on what you can copy.

## A. Offline / portable (recommended) — copy a single `.tgz` file

This is the fastest way. You build a tarball on the source machine once,
then `npm install -g` it on the target.

### On the source machine

```powershell
cd path/to/copilot-llm-proxy
npm install            # only needed if not already done
npm pack               # produces copilot-llm-proxy-0.1.0.tgz (~40 KB)
```

### Copy to the target machine

Copy `copilot-llm-proxy-0.1.0.tgz` via USB, SMB, scp, etc.

### On the target machine

Prerequisites: **Node.js ≥ 18.17**. Then:

```powershell
# Install globally — this puts `cllmp` on your PATH
npm install -g .\copilot-llm-proxy-0.1.0.tgz

# Sign in to your Copilot account (browser device-code flow)
cllmp login

# Configure your client(s)
cllmp setup claude       # interactive picker
cllmp setup codex

# Run the proxy
cllmp start
```

That's it — `claude` / `codex` on the target machine will now hit the proxy
at `http://127.0.0.1:4141` and talk to your Copilot subscription.

To upgrade later, repeat `npm pack` on the source and re-install on the
target with the new `.tgz`.

## B. From a git checkout

If you can `git clone` (or copy the whole source folder) onto the target:

```powershell
git clone <your-clone-url> copilot-llm-proxy
cd copilot-llm-proxy
npm install
npm run build
npm link                 # registers `cllmp` on PATH

cllmp login
cllmp setup claude
cllmp setup codex
cllmp start
```

## Verifying the install

```powershell
cllmp --version
cllmp status             # checks token + Copilot exchange works
curl http://127.0.0.1:4141/healthz
```

## Uninstalling

```powershell
npm uninstall -g copilot-llm-proxy   # if installed via .tgz
# or for a git checkout linked with `npm link`:
npm unlink -g copilot-llm-proxy
cllmp logout             # remove ~/.copilot-llm-proxy/auth.json
```

## Notes

- Each machine maintains its own `~/.copilot-llm-proxy/auth.json` (created
  by `cllmp login`).
- Each machine has independent `~/.codex/config.toml` and
  `~/.claude/settings.json` — run `cllmp setup` on each one.
- All requests go through your Copilot quota for the GitHub account you
  signed in with — same account on multiple machines is fine.

## Publishing to the npm registry

Both `copilot-llm-proxy` and `cllmp` are currently **available** on
npmjs.org. To publish:

### One-time setup

1. Create a free npm account at <https://www.npmjs.com/signup>.
2. Update `package.json` if you want different metadata: `author`,
   `homepage`, `repository.url`, `bugs.url` are placeholders pointing at
   `github.com/heartAndRain/copilot-llm-proxy` — change them to wherever
   you'll actually host the source.
3. Log in:
   ```powershell
   npm login
   ```

### Publish

```powershell
cd path/to/copilot-llm-proxy

# Dry-run first to see what will go up:
npm publish --dry-run

# Real publish (the `prepublishOnly` script auto-runs `clean && build`):
npm publish
```

After it lands, anyone can install with:

```powershell
npm install -g copilot-llm-proxy
cllmp login
cllmp setup claude
cllmp start
```

### Subsequent versions

```powershell
npm version patch      # 0.1.0 → 0.1.1
npm publish
```

### A few things to think about before publishing publicly

- **GitHub policy.** This proxy sends requests to
  `api.githubcopilot.com` using the same headers VS Code Copilot Chat
  uses, then funnels third-party tools through your Copilot subscription.
  Review the
  [GitHub Acceptable Use Policies](https://docs.github.com/en/site-policy/acceptable-use-policies)
  and your Copilot terms — using a Copilot license to back tools other
  than the official Copilot clients may not be permitted depending on
  your plan. Publishing the tool publicly is your own decision.
- **Name squatting.** If you want to reserve the name without committing
  yet, publish an initial `0.0.1` placeholder under your own scope
  (`@you/copilot-llm-proxy`).
- **Two-factor auth.** Enable 2FA on your npm account; npm requires it
  for publishes of newly-created packages by default.
- **Unpublishing has limits.** npm forbids unpublish of any version older
  than 72 hours if anything else depends on it. Push minor/patch bumps
  rather than re-publishing.
