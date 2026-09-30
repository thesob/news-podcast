"""Spell out numbers that TTS voices misread, before they reach the synthesizer.

Only numbers with a decimal/thousands separator, or followed by a percent sign,
are converted; plain integers ("2027", "40") are left for the voice to read.
Separator meaning is per language: EN uses "," for thousands and "." for
decimals; ES/SV use "," for decimals and "." for thousands.
"""

import re

from num2words import num2words

_NUM_RE = re.compile(r"(?<![\w.,])(\d+(?:[.,]\d+)*)(\s?%)?(?![\w])")

_EN_THOUSANDS = re.compile(r"^\d{1,3}(?:,\d{3})+(?:\.\d+)?$")
_ES_THOUSANDS = re.compile(r"^\d{1,3}(?:\.\d{3})+(?:,\d+)?$")
_PLAIN = re.compile(r"^\d+(?:[.,]\d+)?$")

_LANG = {"EN": "en", "ES": "es", "SV": "sv"}
_POINT = {"EN": "point", "ES": "coma", "SV": "komma"}
_PERCENT = {"EN": "percent", "ES": "por ciento", "SV": "procent"}


def _parse(token: str, lang: str):
    """Return (integer digits, fraction digits or None), or None if ambiguous."""
    if lang == "EN":
        if _EN_THOUSANDS.match(token):
            whole, _, frac = token.replace(",", "").partition(".")
            return whole, frac or None
        if _PLAIN.match(token) and "," not in token:
            whole, _, frac = token.partition(".")
            return whole, frac or None
        return None
    if _ES_THOUSANDS.match(token):
        whole, _, frac = token.replace(".", "").partition(",")
        return whole, frac or None
    if _PLAIN.match(token):
        whole, _, frac = token.replace(".", ",").partition(",")
        return whole, frac or None
    return None


def _say(n: str, lang: str) -> str:
    return num2words(int(n), lang=_LANG[lang])


def _fraction(frac: str, lang: str) -> str:
    # "4" -> four, "25" -> veinticinco, but "05" / "125" digit by digit.
    if lang != "EN" and len(frac) <= 2 and not frac.startswith("0"):
        return _say(frac, lang)
    return " ".join(_say(d, lang) for d in frac)


def spell_numbers(text: str, lang: str) -> str:
    if lang not in _LANG:
        return text

    def repl(m: re.Match) -> str:
        token, pct = m.group(1), m.group(2)
        if not (pct or re.search(r"[.,]", token)):
            return m.group(0)
        parsed = _parse(token, lang)
        if parsed is None:
            return m.group(0)
        whole, frac = parsed
        out = _say(whole, lang)
        if frac:
            out += f" {_POINT[lang]} {_fraction(frac, lang)}"
        if pct:
            out += f" {_PERCENT[lang]}"
        return out

    return _NUM_RE.sub(repl, text)
