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
  docs/transcripts/<date>.txt  (raw script, linked from the feed as a transcript)
  docs/feed.xml  (updated, newest episode first)
"""

import calendar
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from google.cloud import texttospeech
from pydub import AudioSegment
from feedgen.feed import FeedGenerator
from feedgen.ext.base import BaseExtension, BaseEntryExtension
from feedgen.util import xml_elem
import feedparser

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT_PATH = REPO_ROOT / "episode" / "script.txt"
DOCS_DIR = REPO_ROOT / "docs"
EPISODES_DIR = DOCS_DIR / "episodes"
TRANSCRIPTS_DIR = DOCS_DIR / "transcripts"
FEED_PATH = DOCS_DIR / "feed.xml"

# Podcasting 2.0 <podcast:transcript> tag (https://podcastindex.org/namespace/1.0).
# feedgen's own "podcast" extension only covers the older iTunes tags, so this
# adds just enough of the newer namespace for one element.
PODCAST_NS = "https://podcastindex.org/namespace/1.0"
EPISODE_DATE_RE = re.compile(r"/episodes/(\d{4}-\d{2}-\d{2})\.mp3$")


class TranscriptExtension(BaseExtension):
    def extend_ns(self):
        return {"podcast": PODCAST_NS}


class TranscriptEntryExtension(BaseEntryExtension):
    def __init__(self):
        self.__url = None
        self.__mime_type = "text/plain"

    def transcript(self, url=None, mime_type=None):
        if url is not None:
            self.__url = url
        if mime_type is not None:
            self.__mime_type = mime_type
        return self.__url

    def extend_rss(self, entry):
        if self.__url:
            tag = xml_elem("{%s}transcript" % PODCAST_NS, entry)
            tag.attrib["url"] = self.__url
            tag.attrib["type"] = self.__mime_type
        return entry

# Map tags to Google Cloud TTS language codes + voice names.
# Standard voices are used by default to maximize free-tier headroom.
# Swap in WaveNet/Neural2 voice names later if you want higher quality
# and don't mind smaller monthly free allowance.
VOICE_MAP = {
    "EN": {"language_code": "en-US", "name": "en-US-Chirp3-HD-Algenib"},
    "ES": {"language_code": "es-US", "name": "es-US-Chirp3-HD-Gacrux"},
    "SV": {"language_code": "sv-SE", "name": "sv-SE-Chirp3-HD-Enceladus"},
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
    new_entry_id = f"{base_url}/episodes/{episode_date}.mp3"

    fg = FeedGenerator()
    fg.load_extension("podcast")
    fg.register_extension(
        "transcript", TranscriptExtension, TranscriptEntryExtension, atom=False
    )
    fg.title(title)
    fg.link(href=f"{base_url}/feed.xml", rel="self")
    fg.link(href=base_url, rel="alternate")
    fg.description(f"{title} — automatically generated multilingual news brief")
    fg.language("en")

    # Today's episode
    today_dt = datetime.now(timezone.utc)
    fe = fg.add_entry()
    fe.id(new_entry_id)
    fe.title(f"{title} — {episode_date}")
    fe.enclosure(new_entry_id, str(mp3_path.stat().st_size), "audio/mpeg")
    fe.pubDate(today_dt)
    fe.podcast.itunes_duration(str(duration_seconds))
    if (TRANSCRIPTS_DIR / f"{episode_date}.txt").exists():
        fe.transcript.transcript(f"{base_url}/transcripts/{episode_date}.txt")

    # Re-add previous episodes (read via feedparser — feedgen itself can only
    # write feeds, not parse them) so we accumulate history instead of
    # overwriting it. Skip any old entry with today's id in case this is a
    # re-run for the same day.
    if FEED_PATH.exists():
        parsed = feedparser.parse(str(FEED_PATH))
        for old_entry in parsed.entries:
            old_id = old_entry.get("id") or old_entry.get("link")
            if not old_id or old_id == new_entry_id:
                continue

            enclosures = old_entry.get("enclosures") or []
            if not enclosures:
                continue  # skip anything malformed rather than fail the whole run

            old_fe = fg.add_entry()
            old_fe.id(old_id)
            old_fe.title(old_entry.get("title", old_id))
            enc = enclosures[0]
            old_fe.enclosure(
                enc.get("href", old_id),
                str(enc.get("length", "0")),
                enc.get("type", "audio/mpeg"),
            )
            if old_entry.get("published_parsed"):
                ts = calendar.timegm(old_entry["published_parsed"])
                old_fe.pubDate(datetime.fromtimestamp(ts, tz=timezone.utc))
            else:
                old_fe.pubDate(today_dt)  # fallback, shouldn't normally happen
            if old_entry.get("itunes_duration"):
                old_fe.podcast.itunes_duration(old_entry["itunes_duration"])
            # Match the transcript by date rather than round-tripping it
            # through feedparser, which doesn't know the podcast namespace
            # and would silently drop it on every rebuild.
            old_date_match = EPISODE_DATE_RE.search(enc.get("href", ""))
            if old_date_match:
                old_date = old_date_match.group(1)
                if (TRANSCRIPTS_DIR / f"{old_date}.txt").exists():
                    old_fe.transcript.transcript(
                        f"{base_url}/transcripts/{old_date}.txt"
                    )

    # Sort newest-first explicitly, rather than depending on the order
    # entries happened to be added in.
    all_entries = fg.entry()
    all_entries.sort(key=lambda e: e.pubDate(), reverse=True)
    fg.entry(all_entries, replace=True)

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

    TRANSCRIPTS_DIR.mkdir(parents=True, exist_ok=True)
    (TRANSCRIPTS_DIR / f"{episode_date}.txt").write_text(text, encoding="utf-8")

    duration_seconds = int(len(audio) / 1000)
    update_feed(mp3_path, episode_date, duration_seconds)
    print(f"Built episode {mp3_path} ({duration_seconds}s) and updated feed.xml")


if __name__ == "__main__":
    main()
