# headlines-proxy

A small Google Cloud Run function (Google's current name for what used to be
called Cloud Functions) that sits between the daily Cowork agent task and
the Guardian / GNews APIs. It holds the real vendor keys (and the podcast
recipient email) server-side, and exposes two narrow, token-gated routes:

- `GET /headlines?lang=en|es|sv&topic=<optional>&q=<optional>&max=<optional>` —
  merged, normalized headlines from whichever upstream(s) support that
  language (Guardian for `en`, GNews for all three). Each article includes a
  `summary` (Guardian's `trailText` dek, or GNews's `description` — one
  line) and an `excerpt` (Guardian's `bodyText`, or GNews's `content` —
  up to ~800 characters, truncated server-side so the payload stays
  bounded even with ~50 articles in one response) so the caller can write
  a real summary without re-fetching every url. `excerpt` can come back
  empty for a given story if the vendor didn't have more to give (GNews's
  `content` is itself capped to ~200 characters on the free plan). `max`
  requests that many articles per upstream, clamped to what each vendor
  allows — GNews caps at 10 on the free plan regardless of what's
  requested; Guardian defaults to 20 and can go up to 50.
- `GET /config` — `{ "recipientEmail": "..." }`, the one non-secret variable
  that used to be hardcoded in `prompts/agent-prompt.md`.

Both routes require `Authorization: Bearer <PROXY_TOKEN>`. See
[`/prompts/agent-prompt.md`](../prompts/agent-prompt.md) for how the Cowork
task is instructed to call this.

**Why it needs a token at all:** an HTTP Cloud Run function URL is public.
Without some credential, anyone who finds the URL could burn your
Guardian/GNews daily quota. `PROXY_TOKEN` is a credential *you* mint — it
authorizes nothing but "call this endpoint" and is trivial to rotate. It's
still a secret that has to live somewhere the live Cowork task can read it
(the Cowork task itself has no secret storage), so it goes in the **live
copy of the prompt pasted into the Cowork task UI — never into the
committed `prompts/agent-prompt.md`**, which stays a placeholder like
everything else in this repo.

---

## A note on how this doc was written

This has already gone through two rounds of corrections because Google's
console UI moved out from under it — function creation is now folded
directly into Cloud Run's own "Create service" flow, and it looks nothing
like what an earlier draft of this doc described. I have no way to click
through your actual console myself, so I can't verify a UI walkthrough the
way I can verify a documented CLI command against Google's own reference
pages. Because of that, **the `gcloud` CLI path below is the one I'd
actually trust** — every command in it is checked against
[the current `gcloud run deploy` docs](https://docs.cloud.google.com/run/docs/deploy-functions),
not reconstructed from memory or a screenshot. The Console path further
down only describes screens you've already shown me; past that point it
says so explicitly instead of guessing.

---

## Before you start: get the two vendor keys

- **Guardian**: go to https://open-platform.theguardian.com/access/ and
  register with your email — a free "Developer" key is emailed to you
  instantly (500 calls/day, non-commercial use).
- **GNews**: go to https://gnews.io/ → sign up → your API key is shown on
  your account dashboard (100 requests/day on the free plan).

Keep both values somewhere private for now (a password manager, not a text
file in this repo) — you'll paste them into Secret Manager below.

---

## Cost, and why this uses Secret Manager (corrected)

**Cloud Run functions itself is free at this scale.** The always-free tier
is 2 million invocations, 400,000 GB-seconds of compute, and 5GB of egress
per month. This function gets called a handful of times once a day — a few
hundred invocations a month at most, each running for a second or two —
which is a rounding error against those numbers. **Secret Manager is free
here too**: its free tier is 6 active secret versions and 10,000 access
operations per month; this uses 3 secrets, and Cloud Run only reads a
`--set-secrets` value on cold start (not per request), so actual usage is a
tiny fraction of either allowance.

An earlier version of this doc argued for skipping Secret Manager by saying
it "mirrors" how the TTS service account key is handled — pasted into a
GitHub Actions secret, no dedicated secret-management product involved.
That comparison doesn't hold up: a **GitHub Actions secret is write-only
once saved** — nobody, including the repo owner, can ever read its value
back through GitHub's UI or API, and GitHub actively redacts it from job
logs if it appears in output. That's much closer to what Secret Manager
gives you than to a plain Cloud Run environment variable, which is
**readable back in plaintext** by anyone with viewer access to the
service — it shows up as-is in the Console's Variables tab and in `gcloud
run services describe`, with no redaction. Using that comparison to justify
a weaker protection for the proxy's keys was a mistake, not a genuine
consistency argument.

Concretely, for this project: it's single-user, so "anyone with read access
to the GCP project" is normally just you — but the setup process itself
routes through a Console UI you'll likely screenshot when troubleshooting
(as happened in this repo's own setup). A Secret Manager reference shows
only a secret's *name* in that UI, never its value, so a screenshot of the
config screen is safe to share; a plain environment variable would put the
real key in plain text in that same screenshot. Secret Manager closes that
gap for the same $0 cost, so it's what this setup uses below.

---

## One-time setup — `gcloud` CLI (recommended)

`gcloud` is a separate program Google publishes — similar to installing
`git` — it isn't part of Windows or PowerShell. Get it from
https://cloud.google.com/sdk/docs/install (Windows installer, no admin
rights needed) and restart your terminal afterwards so it's on `PATH`. Then
run `gcloud init` once to log in and pick the same GCP project you already
created for Text-to-Speech (root [README.md](../README.md), step 1) — no
need for a second project.

All commands below are plain PowerShell, run from **inside this `proxy/`
folder** — `cd proxy` from the repo root first if you're not already there
(this is also where `deploy-flags.example.yaml`, `index.js`, and
`package.json` all live).

### 1. Enable the APIs this needs

```powershell
gcloud config set project YOUR_PROJECT_ID
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com
```

### 2. Generate the proxy token

```powershell
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
```

Copy the printed 64-character hex string — this is your `PROXY_TOKEN`. It
doesn't go in this repo; you'll load it into Secret Manager next, and later
paste it into the live Cowork task prompt.

### 3. Create the three secrets

Writing to a temp file first (instead of piping a string through
PowerShell's pipeline) avoids PowerShell silently adding a trailing newline
to the value — a stray newline would make the stored secret not quite match
what you copied:

```powershell
[System.IO.File]::WriteAllText("$env:TEMP\secret.txt", "YOUR_REAL_GUARDIAN_KEY")
gcloud secrets create GUARDIAN_API_KEY --data-file="$env:TEMP\secret.txt"

[System.IO.File]::WriteAllText("$env:TEMP\secret.txt", "YOUR_REAL_GNEWS_KEY")
gcloud secrets create GNEWS_API_KEY --data-file="$env:TEMP\secret.txt"

[System.IO.File]::WriteAllText("$env:TEMP\secret.txt", "YOUR_GENERATED_TOKEN_FROM_STEP_2")
gcloud secrets create PROXY_TOKEN --data-file="$env:TEMP\secret.txt"

Remove-Item "$env:TEMP\secret.txt"
```

(`RECIPIENT_EMAIL` isn't a secret — it stays a plain `--set-env-vars` value
in the deploy command below, kept out of git without needing Secret Manager
for it specifically.)

### 4. Grant the runtime service account access to those secrets

Creating a secret and referencing it in `--set-secrets` isn't enough on its
own — Cloud Run reads the secret's value at runtime using its own service
account, and that account has no access to anything in Secret Manager by
default. Skip this step and deployment will fail with a "Permission denied
on secret ... must be granted the 'Secret Manager Secret Accessor' role"
error, naming the exact service account to grant it to (it looks like
`PROJECT_NUMBER-compute@developer.gserviceaccount.com` — the project's
default Compute Engine service account, which Cloud Run functions use
unless you've configured a dedicated one).

```powershell
$projectNumber = gcloud projects describe YOUR_PROJECT_ID --format="value(projectNumber)"
$sa = "$projectNumber-compute@developer.gserviceaccount.com"

gcloud secrets add-iam-policy-binding GUARDIAN_API_KEY --member="serviceAccount:$sa" --role="roles/secretmanager.secretAccessor"
gcloud secrets add-iam-policy-binding GNEWS_API_KEY --member="serviceAccount:$sa" --role="roles/secretmanager.secretAccessor"
gcloud secrets add-iam-policy-binding PROXY_TOKEN --member="serviceAccount:$sa" --role="roles/secretmanager.secretAccessor"
```

This grants access per-secret (least privilege — that service account can
read exactly these three secrets and nothing else in Secret Manager), rather
than the broader project-level grant GCP's own error message would also
accept.

If you already tried deploying and hit this error, the service account name
was printed right there in the error message — you can paste it in directly
instead of re-deriving it via `gcloud projects describe`.

### 5. Deploy

**On Windows, don't pass `--set-env-vars`/`--set-secrets` directly on the
command line** — `gcloud` on Windows is actually `gcloud.cmd`, a batch-file
wrapper, and PowerShell handing it off triggers a second round of parsing by
`cmd.exe`, which treats unquoted commas and the `=` signs inside those
values as argument separators. In practice that mangles the value before
gcloud ever sees it (symptom: an "Invalid secret spec" error with commas
turned into spaces). Google ships a `--flags-file` mechanism specifically
to route around this — the flag values live in a YAML file instead of the
command line, so neither shell ever gets a chance to mis-tokenize them.

Copy the template and fill in your real values:

```powershell
Copy-Item deploy-flags.example.yaml deploy-flags.local.yaml
notepad deploy-flags.local.yaml
```

In the opened file, replace `YOUR_REGION` with your region and
`you@example.com` with your real email — leave the three `--set-secrets`
lines as-is, they already point at the secrets you created in step 3.
`deploy-flags.local.yaml` is gitignored, so this is safe to leave filled in
locally.

Then deploy:

```powershell
gcloud run deploy headlines-proxy --flags-file=deploy-flags.local.yaml
```

(If you ever run these commands from Git Bash, WSL, or macOS/Linux instead
of PowerShell, this problem doesn't occur — there's no `.cmd`/`cmd.exe` hop
on those — and the single-line form from earlier drafts of this doc works
fine there. `--flags-file` still works identically if you'd rather use it
anyway.)

- `--source: .` points at the current directory (`index.js` + `package.json`)
  — this assumes you're running from inside `proxy/` as noted above; if
  you're at the repo root instead, change this to `--source: proxy`.
- `--function: headlinesProxy` is the exported entry point in `index.js`.
- `--base-image: nodejs22` is the Node.js runtime; anything ≥ `nodejs20`
  works, since that's the floor `package.json` declares.
- `--allow-unauthenticated` (empty value in the YAML — it's a flag with no
  argument) is required because the Cowork task can only make a plain HTTPS
  request — it can't present a GCP identity token the way another Google
  service could. That's why `index.js` does its own `Authorization: Bearer`
  check in code — the function itself is the enforcement point here, not
  Cloud IAM.
- `--set-secrets` mounts each secret's latest version as the named
  environment variable — this is what keeps the real values out of the
  command line, your shell history, and the service's own plaintext config.

The command prints a **Service URL** when it finishes, shaped like
`https://headlines-proxy-<hash>-<region>.run.app` — that's your
`[YOUR PROXY URL]`. (Cloud Run functions are Cloud Run services under the
hood now, so the URL is a `.run.app` address, not the older
`.cloudfunctions.net` form.)

### 6. Test it

`Invoke-RestMethod` is built into PowerShell — no install needed. Note that
plain `curl` in PowerShell is secretly an alias for a different command with
different flags, so don't copy bash `curl -H` examples verbatim here.

```powershell
$url = "https://headlines-proxy-<hash>-<region>.run.app"   # from step 5's output
$token = "paste the PROXY_TOKEN value from step 2 here"

Invoke-RestMethod -Uri "$url/config" -Headers @{ Authorization = "Bearer $token" }
Invoke-RestMethod -Uri "$url/headlines?lang=es&topic=business" -Headers @{ Authorization = "Bearer $token" }

# Should fail with a 401:
Invoke-RestMethod -Uri "$url/config"
```

### 7. Wire it into the Cowork task

Paste `prompts/agent-prompt.md` into the Cowork task as usual, but before
pasting, fill in the two placeholders that are deliberately left blank in
the committed file:

- `[YOUR PROXY URL]` → the URL from step 5.
- `[YOUR PROXY TOKEN]` → the token from step 2.

Only the *live* copy inside the Cowork task UI gets the real values — the
file in this repo (public) stays a template.

### Updating the code later

Change `index.js` or `package.json`, then just re-run the `gcloud run
deploy` command from step 5 — it rebuilds from the current contents of
`proxy/` and rolls out a new revision. No separate secrets/env-var step is
needed unless you're also changing one of those values.

---

## Alternative: Google Cloud Console

Console UI layouts change without notice and I can't browse yours to verify
one, so treat this as a rough map, not exact steps — match by field
*purpose*, not by exact wording, and if a screen doesn't look like what's
described, the `gcloud` path above is the one to fall back to.

What's confirmed (from screens you've shared): search **"cloud functions"**
in the Console; the result to click is **Cloud Run functions**, not "Cloud
Run" (the broader container-hosting product) or "Cloud Functions API" (just
a Marketplace listing). That takes you to Cloud Run's own **Create
service** screen with **"Write a function"** as one of the source options —
pick **Node.js**. From there you'll need, somewhere in that form: a service
name, a region, **Authentication: Allow public access** (the "allow
unauthenticated" equivalent — required for the same reason as step 5
above), the entry point (`headlinesProxy`), source files (`index.js`,
`package.json` from this folder), and a way to set the values below. Where
exactly those live in the form (likely under a collapsed "Containers,
Networking, Security" section) isn't something I've seen — if you get stuck
there, paste a screenshot and I'll give you the exact next click instead of
guessing.

**Before you screenshot anything on that screen**: if you've already filled
in real values, either blank them out first or crop them out of the image —
this is exactly the "secret ends up in plaintext in the Console UI" gap
Secret Manager is meant to close, and a screenshot defeats that regardless
of which storage mechanism the field itself uses.

| Field | Value |
|---|---|
| `RECIPIENT_EMAIL` (plain env var) | your actual email address |
| `GUARDIAN_API_KEY` | reference to the `GUARDIAN_API_KEY` secret (create it via **Security → Secret Manager** first, same as CLI step 3) |
| `GNEWS_API_KEY` | reference to the `GNEWS_API_KEY` secret |
| `PROXY_TOKEN` | reference to the `PROXY_TOKEN` secret (value generated in CLI step 2 above — that PowerShell snippet works regardless of which path you deploy with) |

The Console's "Reference a secret" flow is expected to prompt you to grant
the runtime service account access at the point you add each one (unlike
the CLI, which silently deploys and fails later — see CLI step 4) — but
that's an expectation from how this pattern usually works in the Console,
not something I've confirmed on this exact screen. If deployment fails with
a "Permission denied on secret" error anyway, CLI step 4's
`gcloud secrets add-iam-policy-binding` commands fix it regardless of which
path you deployed with.

Once deployed, the service's URL (shown on its overview page, `.run.app`
form) is your `[YOUR PROXY URL]` — same **Test it** and **Wire it into the
Cowork task** steps as the CLI path above.

---

## Local development

```powershell
cd proxy
npm install
$env:GUARDIAN_API_KEY="test"; $env:GNEWS_API_KEY="test"; $env:PROXY_TOKEN="test"; $env:RECIPIENT_EMAIL="you@example.com"
npm start
```

Then, in another terminal:

```powershell
Invoke-RestMethod -Uri "http://localhost:8080/config" -Headers @{ Authorization = "Bearer test" }
```

## Known limits (acceptable for a once-a-day caller; revisit if that changes)

- **Cache and rate limiter are per-instance, in-memory.** Cloud Run
  functions can spin up multiple instances, so neither is a hard global
  guarantee — they protect against a single runaway loop or retry storm,
  not against determined abuse. If this ever needs to be a hard global cap,
  move that counter/cache into Firestore or Memorystore.
- **No IAM-level access control on the HTTP endpoint** ("allow public
  access" above) — enforcement is entirely the app-level bearer check in
  `index.js`. To rotate `PROXY_TOKEN`: generate a new one (CLI step 2), add
  it as a new version of the `PROXY_TOKEN` secret (Console: open the secret →
  **New Version**; CLI: write it to a temp file and run `gcloud secrets
  versions add PROXY_TOKEN --data-file=...`), then re-run the deploy command
  from step 5 so the service picks up `:latest` — then update the live
  Cowork task prompt with the new value.
- `RECIPIENT_EMAIL` is the one value that stays a plain environment
  variable rather than a Secret Manager secret — see "Cost, and why this
  uses Secret Manager" above for why that's fine for it specifically (it's
  not a credential, just PII you don't want sitting in a public repo).
