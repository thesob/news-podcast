# Daily multilingual news podcast — setup guide

## What this repo does
End to end, a day looks like this:

1. A daily Cowork/Claude agent task (prompt lives in
   [`/prompts/agent-prompt.md`](/prompts/agent-prompt.md))
   researches the news, writes the brief, and emails it to you as HTML —
   with a plain-text, language-tagged version attached as `script.txt`.
   That task explicitly does **not** touch GitHub itself.
2. A Google Apps Script ([`scripts/gmail-to-github.gs`](scripts/gmail-to-github.gs))
   polls your Gmail inbox every 5 minutes for that email, pulls the
   `script.txt` attachment, and commits it to this repo as
   `episode/script.txt`. This commit is what actually kicks off the pipeline.
3. That push triggers a GitHub Actions workflow
   ([`.github/workflows/build-podcast.yml`](.github/workflows/build-podcast.yml)),
   which runs [`scripts/build_episode.py`](scripts/build_episode.py) to:
   - Read the language-tagged script.
   - Convert each tagged paragraph to speech in the right voice (Google Cloud TTS).
   - Stitch the audio into one MP3.
   - Save the raw script as a transcript file too.
   - Publish everything under `docs/` and update `docs/feed.xml` (a real podcast RSS feed),
     then commit and push that back to the repo.
4. GitHub Pages serves `docs/` publicly, so the feed is a stable URL you can subscribe to.

The Cowork task is scheduled to run daily and send that email. Everything after that is automatic.

---

## One-time setup

### 1. Google Cloud Text-to-Speech
1. Go to https://console.cloud.google.com/ and create a project (or use an existing one).
2. Enable the **Cloud Text-to-Speech API** for that project.
3. Go to **IAM & Admin → Service Accounts → Create Service Account**.
   Give it the role **Editor**, for simplicity.
4. Create a **JSON key** for that service account and download it. Keep this file private — it's a credential.
5. `VOICE_MAP` in `scripts/build_episode.py` currently points at **Chirp3 HD** voices,
   which are billed differently (and have a much smaller — or no — free-tier
   allowance) than the Standard tier. Check current pricing at
   https://cloud.google.com/text-to-speech/pricing before assuming a daily
   3–5k character brief is effectively free; swap `VOICE_MAP` back to
   `*-Standard-*` voice names if you want to stay comfortably inside the free tier.

### 2. Headlines proxy (Cloud Run function)
The Guardian and GNews API keys, and your podcast recipient email, are never
written into `prompts/agent-prompt.md` — that file lives in a **public**
repo (see step 3), and the Cowork task itself has no secret storage of its
own. Instead, a small Cloud Run function (Google's current name for what
used to be called Cloud Functions) in [`/proxy`](/proxy) holds those two
keys and that email server-side, in the same GCP project as step 1, and
exposes a narrow, token-gated `GET /headlines` and `GET /config`. Follow
[`proxy/README.md`](proxy/README.md) to deploy it — you'll come out of that
with a proxy URL and a bearer token to paste into the *live* Cowork task
prompt in step 8 (not into this repo).

### 3. Create the GitHub repo
1. Create a new **public** repository (it needs to be public for the free GitHub Pages hosting to serve the feed without extra setup — the content is just public news, so this is low-risk). Since the repo is public, double-check `prompts/agent-prompt.md` still has the `[YOUR PROXY URL]` / `[YOUR PROXY TOKEN]` placeholders rather than real values before you push.
2. Push the contents of this folder to that repo (or upload the files via GitHub's web UI).

### 4. Enable GitHub Pages
1. In the repo: **Settings → Pages**.
2. Source: **Deploy from a branch**. Branch: `main`, folder: `/docs`.
3. Save. GitHub will give you a URL like `https://<your-username>.github.io/<repo-name>/`.

### 5. Add secrets and variables
In the repo: **Settings → Secrets and variables → Actions**.

- Under **Secrets**, add:
  - `GOOGLE_SERVICE_ACCOUNT_JSON` — paste the *entire contents* of the JSON key file from step 1.
- Under **Variables**, add:
  - `PODCAST_BASE_URL` — e.g. `https://yourusername.github.io/your-repo`
  - `PODCAST_TITLE` — e.g. `My Daily News Brief`

### 6. Test the build manually
1. Edit `episode/script.txt` with a short test in each language (a template is already there).
2. Commit and push to `main`.
3. Go to the **Actions** tab in GitHub — you should see "Build podcast episode" running.
4. When it finishes, check `https://<your PODCAST_BASE_URL>/feed.xml` in a browser — you should see valid XML with one episode.

### 7. Set up the Gmail → GitHub bridge
The Cowork task never talks to GitHub directly — a Google Apps Script watches
your inbox instead and does the commit for it. Set it up once:
1. Go to https://script.google.com → **New project**, and paste in the contents
   of `scripts/gmail-to-github.gs`.
2. **Project Settings** (gear icon) → **Script Properties** → add
   `GITHUB_TOKEN` = a fine-grained GitHub PAT scoped to just this repo, with
   **Contents: Read and write** permission.
3. In the script, update the `CONFIG` constants at the top (repo, subject line
   to watch for) if they don't already match your setup.
4. Run `pushDailyScriptToGithub` once manually from the editor to trigger
   Google's permission prompts (Gmail read + external requests). Approve them.
5. **Triggers** (clock icon, left sidebar) → **Add Trigger**:
   Function: `pushDailyScriptToGithub`, Event source: Time-driven → Minutes
   timer → Every 5 minutes. (There's no native "on email received" trigger in
   Apps Script, so this polls instead — a per-message-id guard means it only
   ever commits once per email, no matter how often it polls and finds
   nothing new.)

### 8. Set up the daily Cowork task
Give your daily Cowork/Claude task the instructions in
[`/prompts/agent-prompt.md`](/prompts/agent-prompt.md) and schedule daily triggering.
Before pasting the prompt into the Cowork task UI, fill in the two
placeholders left blank in the committed file — `[YOUR PROXY URL]` and
`[YOUR PROXY TOKEN]`, from step 2 — in that *live* copy only; never commit
the real values back to this repo.
In short, the task needs to: research and write the brief, call the proxy
for supplementary headlines and the recipient email, send the brief as an
HTML email to that address, and attach a plain-text `script.txt` version with
every paragraph preceded by a `[EN]`/`[ES]`/`[SV]` language tag on its own
line — and explicitly *not* attempt to push anything to GitHub itself (that's
the Apps Script's job, from step 7).

### 9. Subscribe in a podcast app
Apple Podcasts doesn't reliably support private feed URLs. Use **Overcast** (free, App Store) instead:
1. Open Overcast → tap **+** → **Add URL**.
2. Paste your feed URL: `https://<your PODCAST_BASE_URL>/feed.xml`.
3. Subscribe. New episodes should appear once the daily pipeline runs.
4. Overcast supports CarPlay — it'll show up in your CarPlay podcast list.

**If a new episode doesn't show up:** Overcast polls feeds on its own backend
schedule rather than fetching live every time you open the app, so a brand
new/low-traffic feed can lag behind what's actually published. From the
podcast's episode list on the iPhone, pull down until it says "Release to
force refresh" — that bypasses Overcast's cache and re-fetches immediately.
This gesture isn't available from the CarPlay screen, so do it on the phone
before you start driving.

---

## Notes / things you may want to tune later
- Transcripts: each episode's raw script is saved to `docs/transcripts/<date>.txt`
  and linked from `feed.xml` via the Podcasting 2.0 `<podcast:transcript>` tag,
  so apps that support it (Overcast included) can show a transcript.
- Voices: swap the `name` fields in `VOICE_MAP` inside `scripts/build_episode.py`
  for any other Google Cloud TTS voice — Standard, WaveNet, Neural2, or Chirp3 HD —
  depending on the quality/cost tradeoff you want. Google's exact voice names
  occasionally change; if synthesis fails with a "voice not found" error, check
  the current list at https://cloud.google.com/text-to-speech/docs/voices.
- The feed keeps every past episode by default. If you'd rather only keep the last N days,
  that's a small change to `update_feed()` in `scripts/build_episode.py` — ask if you want that added.
