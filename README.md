# Daily multilingual news podcast — setup guide

## What this repo does
Every time `episode/script.txt` is updated and pushed, GitHub Actions:
1. Reads the language-tagged script.
2. Converts each tagged paragraph to speech in the right voice (Google Cloud TTS).
3. Stitches the audio into one MP3.
4. Publishes it at `docs/episodes/<date>.mp3` and updates `docs/feed.xml` (a real podcast RSS feed).
5. GitHub Pages serves `docs/` publicly, so the feed is a stable URL you can subscribe to.

Your Cowork task's only new job each day is to write a correctly-tagged
`episode/script.txt` and push it — everything else is automatic.

---

## One-time setup

### 1. Google Cloud Text-to-Speech (free tier)
1. Go to https://console.cloud.google.com/ and create a project (or use an existing one).
2. Enable the **Cloud Text-to-Speech API** for that project.
3. Go to **IAM & Admin → Service Accounts → Create Service Account**.
   Give it the role **Editor**, for simplicity.
4. Create a **JSON key** for that service account and download it. Keep this file private — it's a credential.
5. Free tier: 4 million characters/month on Standard voices (the default in this repo). A daily 3–5k character brief uses a tiny fraction of that.

### 2. Create the GitHub repo
1. Create a new **public** repository (it needs to be public for the free GitHub Pages hosting to serve the feed without extra setup — the content is just public news, so this is low-risk).
2. Push the contents of this folder to that repo (or upload the files via GitHub's web UI).

### 3. Enable GitHub Pages
1. In the repo: **Settings → Pages**.
2. Source: **Deploy from a branch**. Branch: `main`, folder: `/docs`.
3. Save. GitHub will give you a URL like `https://<your-username>.github.io/<repo-name>/`.

### 4. Add secrets and variables
In the repo: **Settings → Secrets and variables → Actions**.

- Under **Secrets**, add:
  - `GOOGLE_SERVICE_ACCOUNT_JSON` — paste the *entire contents* of the JSON key file from step 1.
- Under **Variables**, add:
  - `PODCAST_BASE_URL` — e.g. `https://yourusername.github.io/your-repo`
  - `PODCAST_TITLE` — e.g. `My Daily News Brief`

### 5. Test it manually
1. Edit `episode/script.txt` with a short test in each language (a template is already there).
2. Commit and push to `main`.
3. Go to the **Actions** tab in GitHub — you should see "Build podcast episode" running.
4. When it finishes, check `https://<your PODCAST_BASE_URL>/feed.xml` in a browser — you should see valid XML with one episode.

### 6. Connect Cowork to GitHub
Same pattern as Gmail: in Cowork, connect the **GitHub** connector and grant it access to this repo.

### 7. Update your Cowork task
Add this to your daily task's instructions:

> After building today's brief, also produce a version of it as a plain-text script
> where every paragraph is preceded by a language tag on its own line — `[EN]`, `[ES]`,
> or `[SV]` — matching the language that paragraph is actually written in. Use this exact
> tag format (see the example script.txt in the repo). Then, using the GitHub connector,
> commit this text as `episode/script.txt` in the `<your-username>/<your-repo>` repository
> on the `main` branch, overwriting the previous version, with commit message
> "Daily script <today's date>".

That commit is what triggers the whole pipeline automatically.

### 8. Subscribe in a podcast app
Apple Podcasts doesn't reliably support private feed URLs. Use **Overcast** (free, App Store) instead:
1. Open Overcast → tap **+** → **Add URL**.
2. Paste your feed URL: `https://<your PODCAST_BASE_URL>/feed.xml`.
3. Subscribe. New episodes will appear automatically once the daily pipeline runs.
4. Overcast supports CarPlay — it'll show up in your CarPlay podcast list.

---

## Notes / things you may want to tune later
- Voices default to Google's **Standard** tier for maximum free-tier headroom. Swap the
  `name` fields in `VOICE_MAP` inside `scripts/build_episode.py` for WaveNet or Neural2
  voices if you want higher quality later (uses more of the free quota, still cheap).
- The feed keeps every past episode by default. If you'd rather only keep the last N days,
  that's a small change to `update_feed()` — ask if you want that added.
- Google's exact voice names occasionally change; if synthesis fails with a "voice not found"
  error, check the current list at https://cloud.google.com/text-to-speech/docs/voices and
  update `VOICE_MAP` accordingly.
