# Episode audio assets

[scripts/build_episode.py](../../scripts/build_episode.py) layers these files
under the synthesized speech:

- an **opening jingle** that plays solo for a few seconds, then fades down into
- a **low-volume background bed** that **changes per section**,
- a short **stinger** at every section change, and
- a soft **pling** between individual news items.

**Every file here is optional.** A missing file just disables that one layer;
with none present the build produces the plain voice episode as before (only
re-encoded at 44.1 kHz / stereo / 128 kbps). So you can add them one at a time.

## Files the build looks for

| file | length | level guide | notes |
| --- | --- | --- | --- |
| `intro_jingle.mp3` | 8–12 s (must exceed 6.5 s) | full, ~-14 LUFS, peak -1 dBFS | plays ~4 s solo, then fades ~2.5 s into the bed; a cut tail is fine |
| `bed_intro.mp3` | 10–20 s **seamless loop** | quiet, matched to the other beds (~-16 LUFS) | under the greeting / sources note |
| `bed_news.mp3` | 20–40 s **seamless loop** | matched to the other beds | under every news subsection (Top Stories, Spain & LatAm, US & International, Tech & Niche, Sweden); longer loop = less obvious repetition |
| `bed_connecting_dots.mp3` | 20–40 s **seamless loop** | matched | under *Connecting the Dots*; ambient/textural, low rhythmic content |
| `bed_hypothesis_watch.mp3` | 20–40 s **seamless loop** | matched | under *Hypothesis Watch*; distinct timbre from the others |
| `section_stinger.mp3` | 1–2.5 s incl. decay | ~jingle level or just under, peak -2 dBFS | trim tight (the build adds 350 ms after it); 1–5 ms fade-in to kill clicks |
| `item_pling.mp3` | 0.2–0.6 s | soft — peak -6 to -10 dBFS | one bell/marimba/sine blip, fast decay, trimmed tight both ends |

## Encoding

- WAV/PCM preferred; 192–320 kbps MP3 is fine. (Lossless source avoids a second
  round of MP3 compression when it is mixed into the episode.)
- **44,100 Hz**, 16-bit, **stereo** for the jingle and beds (mono is OK for the
  stinger/pling — the build forces everything to stereo).
- Keep true peaks **≤ -1 dBFS** so the summed mix doesn't clip.
- The filenames above use `.mp3`. To use a different extension, change the
  matching paths near the top of `build_episode.py` (`INTRO_JINGLE`,
  `BED_FILES`, ...) and keep this table in sync.

## Beds are short loop cells, not long files

Think Apple Loop / cycle region in Logic. The build tiles each loop to the
section's actual spoken length, so you never need to know section duration in
advance and the files stay tiny. To make one clean: set the cycle locators to an
exact bar boundary, check the wrap with Cycle on, bounce the cycle range, and
make sure no reverb/delay tail crosses the loop point. The build also seam-
crossfades each repeat (~200 ms) so a slightly imperfect trim won't tick.

## Tuning without re-rendering

Constants near the top of `build_episode.py`:

- `BED_GAIN_DB` (default -22) — bed level under the voice. Keep the four beds
  loudness-consistent so one value suits all; otherwise split into per-section
  gains here.
- `STINGER_GAIN_DB`, `PLING_GAIN_DB` (default 0) — trim those markers.
- `INTRO_JINGLE_LEAD_MS` / `INTRO_JINGLE_DUCK_MS` — solo time and fade-down time.
- `BED_FADE_MS`, `BED_LOOP_CROSSFADE_MS`, `STINGER_GAP_MS`, `PLING_GAP_MS`.

## Auditioning locally without Google credentials

```
$env:MOCK_TTS = "1"; python scripts/build_episode.py   # PowerShell
```

Speech is replaced with length-proportional silence, so you can check the music,
beds, stingers and plings in `docs/episodes/<today>.mp3` before spending TTS
quota. Unset `MOCK_TTS` for a real run.
