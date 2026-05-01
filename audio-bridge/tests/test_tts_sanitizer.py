"""Pin the f68c373 fix: _sanitize_for_tts strips markdown / emoji /
bare URLs so Aura doesn't read punctuation literally.

Pre-fix Aura was reading **bold** as "star star bold star star" out
loud (Jonathan reported during a bike ride 2026-05-01). The expanded
regex set covers bold / italic / headers / bullets / code blocks /
bare URLs / a wide emoji range. The canonical reference set lives in
`test/tts-clean.test.ts` for the PWA-side cleanForTts; this Python
suite verifies the bridge-side regex set produces equivalent output
from the same inputs.
"""

import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from stt_bridge import _sanitize_for_tts


def test_no_markup_passthrough():
    """Plain prose is unchanged — sanitizer is idempotent on clean input."""
    text = "The forecast is sunny with a high of 22 degrees."
    assert _sanitize_for_tts(text) == text


def test_strips_bold():
    assert _sanitize_for_tts("**bold**") == "bold"
    assert _sanitize_for_tts("This is **important** info") == "This is important info"


def test_strips_italic_star_form():
    assert _sanitize_for_tts("*italic*") == "italic"
    assert _sanitize_for_tts("Just *one* word") == "Just one word"


def test_strips_italic_underscore_form():
    assert _sanitize_for_tts("_italic_") == "italic"
    assert _sanitize_for_tts("Just _one_ word") == "Just one word"


def test_strips_header():
    assert _sanitize_for_tts("# Header") == "Header"
    assert _sanitize_for_tts("## Subheader") == "Subheader"
    # Mid-document header line.
    assert _sanitize_for_tts("intro\n# Header\nbody") == "intro\nHeader\nbody"


def test_strips_bullet():
    assert _sanitize_for_tts("- bullet item") == "bullet item"
    assert _sanitize_for_tts("* star bullet") == "star bullet"
    # Multiple bullets in a list.
    assert (
        _sanitize_for_tts("intro\n- one\n- two\n- three")
        == "intro\none\ntwo\nthree"
    )


def test_replaces_bare_url():
    """Bare URLs read aloud are useless ("aitch tee tee pee colon …"); the
    sanitizer swaps them for a fixed phrase."""
    out = _sanitize_for_tts("Visit https://example.com today")
    assert "https://" not in out
    assert "(link in canvas)" in out


def test_strips_emoji():
    # The fix's emoji ranges include the wide BMP emoji block (1F300–1FAFF).
    assert _sanitize_for_tts("Hello 🤖 world") == "Hello  world"
    # The 2600–27BF range covers ✓ ✗ ☀ ☁ ☎ ⚠ etc. — these read
    # literally as "check mark" / "warning" if not stripped.
    assert "✓" not in _sanitize_for_tts("All done ✓")
    assert "⚠" not in _sanitize_for_tts("Note ⚠ warning")


def test_combined_markdown_input():
    """End-to-end: a single string with several flavours of markup
    produces a TTS-clean output where none of the markup characters
    survive in the positions that matter."""
    raw = (
        "# Recipe\n"
        "- Chop **onions** finely\n"
        "- Saute in *butter*\n"
        "Visit https://example.com 🍳 for more.\n"
    )
    out = _sanitize_for_tts(raw)
    assert "**" not in out
    assert "# " not in out
    assert "- " not in out
    assert "https://" not in out
    assert "🍳" not in out
    assert "onions" in out
    assert "butter" in out
    assert "(link in canvas)" in out


def test_idempotent():
    """Running the sanitizer twice is a no-op — guards against regex
    sets that introduce new markup-like characters on each pass."""
    raw = "**bold** *italic* https://example.com 🚀"
    once = _sanitize_for_tts(raw)
    twice = _sanitize_for_tts(once)
    assert once == twice
