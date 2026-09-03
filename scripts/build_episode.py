#!/usr/bin/env python3
"""
Builds one podcast episode from a language-tagged script, and updates feed.xml.

INPUT FORMAT (episode/script.txt):
  Each paragraph starts with a language tag, [EN], [ES], or [SV], followed by
  one or more lines of text in that language. The tag may sit alone on its
  own line or share the line with the start of the paragraph text. Example:

    [EN]
    Good morning. Here are today's top stories.

    [ES] Los mercados bursátiles cerraron con fuertes ganancias hoy.

    [SV]
    Vädret idag väntas vara soligt över hela landet.

  An optional section marker on its own line, one of
  [SECTION news], [SECTION connecting_dots], [SECTION hypothesis_watch],
  [SECTION intro], switches the background bed for the paragraphs that follow.
  Markers are never spoken and are stripped from the archived transcript. When
  absent, sections are detected heuristically from the spoken heading lines
  ("Top Stories.", "Connecting the Dots.", "Hypothesis Watch.", ...).

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
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from google.cloud import texttospeech
from pydub import AudioSegment
from feedgen.feed import FeedGenerator
from feedgen.ext.base import BaseExtension, BaseEntryExtension
from feedgen.util import xml_elem
import feedparser

try:
    import numpy as np
    import pyloudnorm as pyln
except ImportError:  # loudness normalization is an optional layer, like the assets
    np = None
    pyln = None

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
    "ES": {"language_code": "es-US", "name": "es-US-Chirp3-HD-Achernar"},
    "SV": {"language_code": "sv-SE", "name": "sv-SE-Chirp3-HD-Enceladus"},
}

TAG_RE = re.compile(r"^\[(EN|ES|SV)\]\s*(.*)$")

# ---------------------------------------------------------------------------
# Audio production: opening jingle, per-section background beds, section
# stingers and inter-item plings. Every asset below is optional; a missing
# file just disables that one layer (see build_audio).
# ---------------------------------------------------------------------------
ASSETS_DIR = REPO_ROOT / "assets" / "audio"
INTRO_JINGLE = ASSETS_DIR / "intro_jingle.mp3"
SECTION_STINGER = ASSETS_DIR / "section_stinger.mp3"
ITEM_PLING = ASSETS_DIR / "item_pling.mp3"
BED_FILES = {
    "intro": ASSETS_DIR / "bed_intro.mp3",
    "news": ASSETS_DIR / "bed_news.mp3",
    "connecting_dots": ASSETS_DIR / "bed_connecting_dots.mp3",
    "hypothesis_watch": ASSETS_DIR / "bed_hypothesis_watch.mp3",
}

BED_GAIN_DB = -22          # looping bed level relative to the voice
STINGER_GAIN_DB = 0        # trim the section stinger without re-rendering it
PLING_GAIN_DB = 0          # trim the item pling without re-rendering it
BED_FADE_MS = 800          # fade in/out at each bed span boundary
BED_LOOP_CROSSFADE_MS = 200  # seam crossfade when tiling a short loop
INTRO_JINGLE_LEAD_MS = 4000   # jingle plays solo before the first words
INTRO_JINGLE_DUCK_MS = 2500   # jingle fades down into the bed under first words
STINGER_GAP_MS = 350         # silence after a section stinger, before speech
PLING_GAP_MS = 250           # silence after an item pling, before speech
SEGMENT_PAUSE_MS = 500       # pause between spoken paragraphs

# Loudness normalization (ITU-R BS.1770 integrated loudness, via pyloudnorm).
# Two layers: every spoken segment is leveled to VOICE_TARGET_LUFS before the
# mix, so the EN/ES/SV voices enter equally loud regardless of how hot each
# language's TTS renders; the finished episode is then brought to
# MASTER_TARGET_LUFS and pulled back below MASTER_PEAK_DBFS if a transient
# still pokes above the ceiling. All of this no-ops if pyloudnorm is missing
# or the audio is too short/quiet to measure.
VOICE_TARGET_LUFS = -20.0    # per-segment speech level, pre-mix
MASTER_TARGET_LUFS = -16.0   # finished-episode level (Apple Podcasts target)
MASTER_PEAK_DBFS = -1.0      # peak ceiling applied after the master pass
LOUDNORM_MIN_MS = 400        # BS.1770 needs at least one 400 ms block

# Static assets are leveled on load too - a file dropped into assets/audio/ is
# not trusted to already sit at the right level. jingle / beds / stinger are
# brought to ASSET_TARGET_LUFS; this is the bed's *standalone* level, BED_GAIN_DB
# is still applied on top to push it under the voice. The pling is a sub-second
# one-shot with too little audio for BS.1770 gating, so it's peak-normalized
# instead. If pyloudnorm is missing the jingle/beds/stinger fall back to the
# same peak target.
ASSET_TARGET_LUFS = -16.0        # ~4 LU above the -20 LUFS voice
ASSET_PEAK_FALLBACK_DBFS = -2.0  # jingle/beds/stinger when LUFS can't be measured
PLING_TARGET_PEAK_DBFS = -8.0    # mid of the -6..-10 dBFS guide in the assets README

OUTPUT_FRAME_RATE = 44100
OUTPUT_CHANNELS = 2
OUTPUT_BITRATE = "128k"

# Explicit section marker, e.g. a line reading "[SECTION connecting_dots]".
SECTION_RE = re.compile(r"^\[SECTION\s+([a-z_]+)\]\s*$", re.I)
SECTION_LINE_RE = re.compile(r"(?m)^\[SECTION\s+\S+\]\s*\n?")
SECTIONS = ("intro", "news", "connecting_dots", "hypothesis_watch")

# Heuristic fallback: normalized spoken heading -> section id. Used only when
# the script carries no explicit [SECTION ...] markers for that boundary.
HEADING_SECTIONS = {
    "top stories": "news",
    "espana y latinoamerica": "news",
    "us and international": "news",
    "tech and niche": "news",
    "sverige": "news",
    "sweden": "news",
    "connecting the dots": "connecting_dots",
    "hypothesis watch": "hypothesis_watch",
}

# Spoken sub-dividers inside the news block. They keep the news bed but should
# not get an inter-item pling in front of them.
NEWS_SUBHEADINGS = {h for h, s in HEADING_SECTIONS.items() if s == "news"}


@dataclass
class Segment:
    lang: str
    text: str
    section: str = "intro"
    is_section_start: bool = False


def _normalize_heading(text: str) -> str:
    """Lowercase, strip accents, drop trailing period, collapse whitespace."""
    stripped = "".join(
        c for c in unicodedata.normalize("NFKD", text) if not unicodedata.combining(c)
    )
    return re.sub(r"\s+", " ", stripped.strip().rstrip(".").lower())


def parse_segments(text: str):
    """Split the tagged script into a list of Segment objects.

    Accepts the language tag either alone on its own line, with the paragraph
    text following on subsequent lines, or with the paragraph text starting
    right after the tag on the same line:

        [EN]
        Good morning.

        [EN] Good morning.

    An optional "[SECTION <id>]" line on its own switches the section (and
    background bed) for the paragraphs that follow. When no marker precedes a
    section, the section is inferred from the spoken heading line via
    HEADING_SECTIONS.
    """
    lines = text.splitlines()
    segments: list[Segment] = []
    current_lang = None
    current_lines: list[str] = []
    current_section = "intro"
    pending_section_start = False

    def flush():
        nonlocal pending_section_start, current_section, current_lines
        if not (current_lang and current_lines):
            return
        body = "\n".join(current_lines).strip()
        current_lines = []  # consumed - don't re-emit on the next flush()
        if not body:
            return
        section = current_section
        is_start = pending_section_start
        heading = HEADING_SECTIONS.get(_normalize_heading(body))
        if heading and heading != section:
            section = heading
            is_start = True
        segments.append(Segment(current_lang, body, section, is_start))
        # keep the heuristic-derived section for following paragraphs
        current_section = section
        pending_section_start = False

    for line in lines:
        stripped = line.strip()
        sec_m = SECTION_RE.match(stripped)
        if sec_m:
            flush()
            sec = sec_m.group(1).lower()
            if sec in SECTIONS:
                current_section = sec
                pending_section_start = True
            else:
                print(
                    f"[audio] unknown [SECTION {sec}] marker, ignoring", file=sys.stderr
                )
            continue

        m = TAG_RE.match(stripped)
        if m:
            flush()
            current_lang = m.group(1)
            current_lines = [m.group(2)] if m.group(2) else []
        else:
            current_lines.append(line)
    flush()

    if not segments:
        raise ValueError(
            "No tagged segments found. Make sure script.txt uses [EN]/[ES]/[SV] "
            "tags on their own line before each paragraph."
        )
    return segments


def _silence(ms: int) -> AudioSegment:
    """Silence at the module's output format, so nothing depends on pydub's
    default 11025 Hz mono when other layers are absent."""
    return AudioSegment.silent(
        duration=max(0, ms), frame_rate=OUTPUT_FRAME_RATE
    ).set_channels(OUTPUT_CHANNELS)


def _measure_lufs(seg: AudioSegment):
    """Integrated loudness (LUFS, ITU-R BS.1770) of seg, or None when it can't be
    measured: pyloudnorm not installed, segment shorter than one gating block, or
    silent/near-silent (loudness -inf)."""
    if pyln is None or len(seg) < LOUDNORM_MIN_MS:
        return None
    samples = np.array(seg.get_array_of_samples(), dtype=np.float64)
    if seg.channels > 1:
        samples = samples.reshape((-1, seg.channels))
    samples /= 1 << (8 * seg.sample_width - 1)  # integer PCM -> [-1.0, 1.0)
    loudness = pyln.Meter(seg.frame_rate).integrated_loudness(samples)
    return float(loudness) if np.isfinite(loudness) else None


def _normalize_loudness(seg: AudioSegment, target_lufs: float) -> AudioSegment:
    """Gain-shift seg so its integrated loudness sits at target_lufs. No-op when
    the loudness can't be measured (see _measure_lufs)."""
    loudness = _measure_lufs(seg)
    if loudness is None:
        return seg
    return seg.apply_gain(target_lufs - loudness)


def _normalize_peak(seg: AudioSegment, target_dbfs: float) -> AudioSegment:
    """Gain-shift seg so its peak sits at target_dbfs. For one-shots too short
    for BS.1770 loudness gating, and as the fallback when pyloudnorm is absent."""
    if seg.max_dBFS == float("-inf"):
        return seg
    return seg.apply_gain(target_dbfs - seg.max_dBFS)


def _load_asset(path: Path, *, target_lufs=None, peak_dbfs=None):
    """Load an optional audio asset, or return None (with a note) if missing.

    A dropped-in file is not trusted to already sit at the right level: when
    target_lufs is given the asset is leveled to it (integrated loudness), and
    when it can't be measured - or only peak_dbfs is given - the asset is
    peak-normalized to peak_dbfs instead."""
    if not path.exists():
        print(f"[audio] optional asset missing, skipping: {path}", file=sys.stderr)
        return None
    seg = AudioSegment.from_file(path)
    seg = seg.set_frame_rate(OUTPUT_FRAME_RATE).set_channels(OUTPUT_CHANNELS)
    if target_lufs is not None and _measure_lufs(seg) is not None:
        return _normalize_loudness(seg, target_lufs)
    if peak_dbfs is not None:
        return _normalize_peak(seg, peak_dbfs)
    return seg


def _loop_to_length(seg, length_ms: int) -> AudioSegment:
    """Tile a short loop to cover length_ms, joining repeats with a short seam
    crossfade so a slightly imperfect loop trim doesn't tick, then fade the
    span in and out at its boundaries."""
    if seg is None or length_ms <= 0:
        return _silence(length_ms)
    xfade = min(BED_LOOP_CROSSFADE_MS, len(seg) // 4)
    out = seg
    while len(out) < length_ms:
        out = out.append(seg, crossfade=xfade)
    edge = min(BED_FADE_MS, length_ms // 2)
    return out[:length_ms].fade_in(edge).fade_out(edge)


def synthesize_segment(client, lang: str, text: str) -> AudioSegment:
    if os.environ.get("MOCK_TTS"):
        # Offline mix testing: stand-in speech, roughly length-proportional.
        return _silence(max(1200, len(text) * 55))
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
    """Assemble the episode: an opening jingle that settles into a low background
    bed, per-section beds, a stinger at every section change and a soft pling
    between news items. Every audio asset is optional - a missing one just
    disables that layer, and with none present this returns the plain voice
    concatenation, re-encoded at the output format and brought to the standard
    episode loudness (MASTER_TARGET_LUFS)."""
    client = None if os.environ.get("MOCK_TTS") else texttospeech.TextToSpeechClient()

    lvl = dict(target_lufs=ASSET_TARGET_LUFS, peak_dbfs=ASSET_PEAK_FALLBACK_DBFS)
    jingle = _load_asset(INTRO_JINGLE, **lvl)
    stinger = _load_asset(SECTION_STINGER, **lvl)
    pling = _load_asset(ITEM_PLING, peak_dbfs=PLING_TARGET_PEAK_DBFS)
    beds = {sec: _load_asset(path, **lvl) for sec, path in BED_FILES.items()}

    pause = _silence(SEGMENT_PAUSE_MS)
    lead_ms = INTRO_JINGLE_LEAD_MS if jingle is not None else 0

    # 1. Voice track: speech plus diegetic stingers/plings, pushed back by the
    #    solo-jingle lead so the first words land after the intro.
    voice = _silence(lead_ms)
    spans: list[tuple[str, int, int]] = []
    current_section = segments[0].section
    span_start = len(voice)
    news_item_seen = False

    for seg in segments:
        if seg.section != current_section:
            spans.append((current_section, span_start, len(voice)))
            current_section = seg.section
            span_start = len(voice)
            news_item_seen = False

        is_news_item = (
            seg.section == "news"
            and not seg.is_section_start
            and _normalize_heading(seg.text) not in NEWS_SUBHEADINGS
        )

        if seg.is_section_start and stinger is not None and len(voice) > lead_ms:
            voice += stinger.apply_gain(STINGER_GAIN_DB) + _silence(STINGER_GAP_MS)
        elif is_news_item and news_item_seen and pling is not None:
            voice += pling.apply_gain(PLING_GAIN_DB) + _silence(PLING_GAP_MS)

        spoken = _normalize_loudness(
            synthesize_segment(client, seg.lang, seg.text), VOICE_TARGET_LUFS
        )
        voice += spoken + pause
        if is_news_item:
            news_item_seen = True

    spans.append((current_section, span_start, len(voice)))
    total_ms = len(voice)

    # 2. Background bed: one looped bed per section span, each fading in/out at
    #    its own boundaries so bed timing never drifts against the voice.
    bed_track = _silence(total_ms)
    for section, start, end in spans:
        span_bed = _loop_to_length(beds.get(section), end - start)
        bed_track = bed_track.overlay(span_bed.apply_gain(BED_GAIN_DB), position=start)

    # 3. Opening jingle: solo for the lead, then fades down into the bed as the
    #    first words come in.
    if jingle is not None:
        intro = jingle[: lead_ms + INTRO_JINGLE_DUCK_MS].fade_out(INTRO_JINGLE_DUCK_MS)
        bed_track = bed_track.overlay(intro, position=0)

    # 4. Mix voice over the bed.
    final = bed_track.overlay(voice)
    final = final.set_frame_rate(OUTPUT_FRAME_RATE).set_channels(OUTPUT_CHANNELS)

    # 5. Master: bring the whole episode to a standard podcast loudness, then
    #    pull the level back if a transient still sits above the peak ceiling
    #    (pyloudnorm sets loudness, not true peak, so guard the encode here).
    final = _normalize_loudness(final, MASTER_TARGET_LUFS)
    if final.max_dBFS > MASTER_PEAK_DBFS:
        final = final.apply_gain(MASTER_PEAK_DBFS - final.max_dBFS)
    return final


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
    audio.export(mp3_path, format="mp3", bitrate=OUTPUT_BITRATE)

    TRANSCRIPTS_DIR.mkdir(parents=True, exist_ok=True)
    transcript = SECTION_LINE_RE.sub("", text)  # drop [SECTION ...] marker lines
    (TRANSCRIPTS_DIR / f"{episode_date}.txt").write_text(transcript, encoding="utf-8")

    duration_seconds = int(len(audio) / 1000)
    update_feed(mp3_path, episode_date, duration_seconds)
    print(f"Built episode {mp3_path} ({duration_seconds}s) and updated feed.xml")


if __name__ == "__main__":
    main()
