#!/usr/bin/env python3
"""
Builds one podcast episode from a language-tagged script, and updates feed.xml.

INPUT FORMAT (episode/script.txt):
  Each paragraph starts with a language tag on its own line: [EN], [ES], or [SV]
  followed by one or more lines of text in that language. Example:

    [EN]
    Good morning. Here are today's top stories.

    [ES]
    Los mercados bursátiles cerraron con fuertes ganancias hoy.

    [SV]
    Vädret idag väntas vara soligt över hela landet.

Requires env vars:
  GOOGLE_APPLICATION_CREDENTIALS - path to a Google service account JSON key
  PODCAST_BASE_URL - e.g. https://username.github.io/reponame
  PODCAST_TITLE - e.g. "My Daily News Brief"

Outputs:
  docs/episodes/<date>.mp3
  docs/feed.xml  (updated, newest episode first)
"""

import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from google.cloud import texttospeech
from pydub import AudioSegment
from feedgen.feed import FeedGenerator

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT_PATH = REPO_ROOT / "episode" / "script.txt"
DOCS_DIR = REPO_ROOT / "docs"
EPISODES_DIR = DOCS_DIR / "episodes"
FEED_PATH = DOCS_DIR / "feed.xml"

# Map tags to Google Cloud TTS language codes + voice names.
# Standard voices are used by default to maximize free-tier headroom.
# Swap in WaveNet/Neural2 voice names later if you want higher quality
# and don't mind smaller monthly free allowance.
VOICE_MAP = {
    "EN": {"language_code": "en-US", "name": "en-US-Standard-C"},
    "ES": {"language_code": "es-ES", "name": "es-ES-Standard-A"},
    "SV": {"language_code": "sv-SE", "name": "sv-SE-Standard-A"},
}

TAG_RE = re.compile(r"^\[(EN|ES|SV)\]\s*$")


def parse_segments(text: str):
    """Split the tagged script into a list of (lang, text) segments."""
    lines = text.splitlines()
    segments = []
    current_lang = None
    current_lines = []

    def flush():
        if current_lang and current_lines:
            body = "\n".join(current_lines).strip()
            if body:
                segments.append((current_lang, body))

    for line in lines:
        m = TAG_RE.match(line.strip())
        if m:
            flush()
            current_lang = m.group(1)
            current_lines = []
        else:
            current_lines.append(line)
    flush()

    if not segments:
        raise ValueError(
            "No tagged segments found. Make sure script.txt uses [EN]/[ES]/[SV] "
            "tags on their own line before each paragraph."
        )
    return segments


def synthesize_segment(client, lang: str, text: str) -> AudioSegment:
    voice_cfg = VOICE_MAP[lang]
    synthesis_input = texttospeech.SynthesisInput(text=text)
    voice = texttospeech.VoiceSelectionParams(
        language_code=voice_cfg["language_code"], name=voice_cfg["name"]
    )
    audio_config = texttospeech.AudioConfig(
        audio_encoding=texttospeech.AudioEncoding.MP3
    )
    response = client.synthesize_speech(
        input=synthesis_input, voice=voice, audio_config=audio_config
    )
    tmp_path = REPO_ROOT / f"_tmp_{lang}_{abs(hash(text)) % 100000}.mp3"
    tmp_path.write_bytes(response.audio_content)
    audio = AudioSegment.from_mp3(tmp_path)
    tmp_path.unlink()
    return audio


def build_audio(segments) -> AudioSegment:
    client = texttospeech.TextToSpeechClient()
    combined = AudioSegment.empty()
    pause = AudioSegment.silent(duration=500)  # brief pause between segments
    for lang, text in segments:
        combined += synthesize_segment(client, lang, text) + pause
    return combined


def update_feed(mp3_path: Path, episode_date: str, duration_seconds: int):
    base_url = os.environ["PODCAST_BASE_URL"].rstrip("/")
    title = os.environ.get("PODCAST_TITLE", "Daily News Brief")

    fg = FeedGenerator()
    fg.load_extension("podcast")
    fg.title(title)
    fg.link(href=f"{base_url}/feed.xml", rel="self")
    fg.link(href=base_url, rel="alternate")
    fg.description(f"{title} — automatically generated multilingual news brief")
    fg.language("en")

    # Re-add existing episodes (newest first) if a feed already exists,
    # so we accumulate history instead of overwriting it.
    existing_entries = []
    if FEED_PATH.exists():
        old_fg = FeedGenerator()
        old_fg.load_extension("podcast")
        old_fg.parse(str(FEED_PATH))
        for e in old_fg.entry():
            if e.id() != f"{base_url}/episodes/{episode_date}.mp3":
                existing_entries.append(e)

    fe = fg.add_entry()
    fe.id(f"{base_url}/episodes/{episode_date}.mp3")
    fe.title(f"{title} — {episode_date}")
    fe.enclosure(
        f"{base_url}/episodes/{episode_date}.mp3",
        str(mp3_path.stat().st_size),
        "audio/mpeg",
    )
    fe.pubDate(datetime.now(timezone.utc))
    fe.podcast.itunes_duration(str(duration_seconds))

    for old_e in existing_entries:
        new_e = fg.add_entry()
        new_e.id(old_e.id())
        new_e.title(old_e.title())
        enc = old_e.enclosure()
        if enc:
            new_e.enclosure(enc.get("url"), enc.get("length"), enc.get("type"))
        if old_e.pubDate():
            new_e.pubDate(old_e.pubDate())

    DOCS_DIR.mkdir(parents=True, exist_ok=True)
    fg.rss_file(str(FEED_PATH))


def main():
    if not SCRIPT_PATH.exists():
        print(f"No script found at {SCRIPT_PATH}", file=sys.stderr)
        sys.exit(1)

    text = SCRIPT_PATH.read_text(encoding="utf-8")
    segments = parse_segments(text)
    audio = build_audio(segments)

    episode_date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    EPISODES_DIR.mkdir(parents=True, exist_ok=True)
    mp3_path = EPISODES_DIR / f"{episode_date}.mp3"
    audio.export(mp3_path, format="mp3", bitrate="96k")

    duration_seconds = int(len(audio) / 1000)
    update_feed(mp3_path, episode_date, duration_seconds)
    print(f"Built episode {mp3_path} ({duration_seconds}s) and updated feed.xml")


if __name__ == "__main__":
    main()
