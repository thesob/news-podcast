#!/usr/bin/env python3
"""
Assembles each edition's agent prompt from the shared base plus that edition's
own pieces.

  prompts/base.md                      shared mechanics, with {{PLACEHOLDERS}}
  editions/<id>/prompt/<slot>.md       one file per text slot (sources.md ->
                                       {{SOURCES}}, connecting-dots.md ->
                                       {{CONNECTING_DOTS}}, ...)
  editions/<id>/profile.json "prompt"  short single-line variables
                                       (subject_name -> {{SUBJECT_NAME}}, ...)

Output: prompts/agent-prompt.md for the default edition (en), and
prompts/agent-prompt.<id>.md for every other edition. Those files are what you
paste into the Cowork task. They are GENERATED: edit the pieces, then re-run

    python scripts/assemble_prompt.py            # rewrite all
    python scripts/assemble_prompt.py es         # just one edition
    python scripts/assemble_prompt.py --check    # exit 1 if any output is stale

Slot files may contain <!-- html comments -->; they are stripped, so notes to
yourself never reach the agent. A multi-line slot placed after a list marker or
indentation in base.md is re-indented to that column, so slot files stay
unindented and easy to edit.

Auto variables (no need to define them): {{EDITION_ID}},
{{HYPOTHESIS_LOG_URL}}, {{HYPOTHESIS_REVIEWS_URL}}.
"""

import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BASE_PATH = REPO_ROOT / "prompts" / "base.md"
EDITIONS_DIR = REPO_ROOT / "editions"
DEFAULT_EDITION = "en"
SITE_URL = "https://thesob.github.io/news-podcast"  # public Pages site

PLACEHOLDER_RE = re.compile(r"\{\{([A-Z0-9_]+)\}\}")
COMMENT_RE = re.compile(r"<!--.*?-->\n?", re.DOTALL)
MARKER_PREFIX_RE = re.compile(r"\s*(?:\d+\.|-)?\s*")


def output_path(edition: str) -> Path:
    name = "agent-prompt.md" if edition == DEFAULT_EDITION else f"agent-prompt.{edition}.md"
    return REPO_ROOT / "prompts" / name


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8").replace("\r\n", "\n")


def slot_name(path: Path) -> str:
    return path.stem.upper().replace("-", "_")


def load_values(edition: str) -> dict:
    prompt_dir = EDITIONS_DIR / edition / "prompt"
    if not prompt_dir.is_dir():
        raise SystemExit(f"[{edition}] no prompt pieces at {prompt_dir}")
    values = {}
    for f in sorted(prompt_dir.glob("*.md")):
        text = COMMENT_RE.sub("", read_text(f)).strip("\n")
        values[slot_name(f)] = text

    profile_path = EDITIONS_DIR / edition / "profile.json"
    profile = json.loads(read_text(profile_path)) if profile_path.exists() else {}
    for key, val in profile.get("prompt", {}).items():
        name = key.upper()
        if name in values:
            raise SystemExit(f"[{edition}] {name} defined both as a slot file and a profile variable")
        values[name] = str(val)

    prefix = "" if edition == DEFAULT_EDITION else f"/{edition}"
    values.setdefault("EDITION_ID", edition)
    values.setdefault("HYPOTHESIS_LOG_URL", f"{SITE_URL}{prefix}/hypothesis-log.md")
    values.setdefault("HYPOTHESIS_REVIEWS_URL", f"{SITE_URL}{prefix}/hypothesis-reviews.md")
    return values


def continuation_indent(line: str, start: int) -> str:
    prefix = line[:start]
    if MARKER_PREFIX_RE.fullmatch(prefix):
        return " " * len(prefix)  # slot sits at a list-item / indented text start
    return " " * (len(line) - len(line.lstrip(" ")))  # mid-sentence: line's own indent


def assemble(edition: str) -> str:
    values = load_values(edition)
    used = set()
    out_lines = []
    for line in read_text(BASE_PATH).split("\n"):
        def fill(m, line=line):
            name = m.group(1)
            if name not in values:
                raise SystemExit(f"[{edition}] base.md uses {{{{{name}}}}} but the edition defines no such slot/variable")
            used.add(name)
            indent = continuation_indent(line, m.start())
            first, *rest = values[name].split("\n")
            return "\n".join([first] + [indent + r if r else r for r in rest])
        out_lines.append(PLACEHOLDER_RE.sub(fill, line))
    unused = sorted(set(values) - used - {"EDITION_ID", "HYPOTHESIS_LOG_URL", "HYPOTHESIS_REVIEWS_URL"})
    if unused:
        raise SystemExit(f"[{edition}] defined but never used in base.md: {', '.join(unused)}")
    return "\n".join(out_lines)


def editions_with_prompts():
    return sorted(p.name for p in EDITIONS_DIR.iterdir() if (p / "prompt").is_dir())


def main(argv):
    check = "--check" in argv
    wanted = [a for a in argv if not a.startswith("--")] or editions_with_prompts()
    stale = []
    for ed in wanted:
        text = assemble(ed)
        path = output_path(ed)
        current = read_text(path) if path.exists() else None
        if check:
            if current != text:
                stale.append(path.name)
        else:
            if current != text:
                path.write_text(text, encoding="utf-8", newline="\n")
                print(f"[{ed}] wrote {path.relative_to(REPO_ROOT)}")
            else:
                print(f"[{ed}] {path.relative_to(REPO_ROOT)} already up to date")
    if stale:
        print("Stale generated prompt(s): " + ", ".join(stale) +
              "\nRun: python scripts/assemble_prompt.py", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
