#!/usr/bin/env python3
"""Runs between paperless-gpt's two steps and after them, since nothing in
Paperless runs when paperless-gpt writes. Run inside the paperless container
every 2 minutes by aborii's user timer (systemd/paperless-after-ai.*).

Between reading and naming: a document paperless-gpt has read (tagged
"ai-read") has repeated text cut out of it, then is tagged "ai-name" for the
naming workflow. The vision model sometimes writes a watermark or a security
pattern over and over: a transcript came back as the university's name 5,681
times, and was named from that. A line, or a phrase of up to 8 words, written
10 or more times in a row is kept once. Real text never repeats like that.

A loop also means the page's own text was never written: the model stops at
VISION_LLM_MAX_TOKENS still repeating. When the cut is that big, Paperless's
own OCR of every page (Tesseract, the archive PDF's text layer) is added after
the AI's text under a heading, so search and naming still see those pages.
qwen2.5vl and qwen3-vl both loop on a transcript with its university's name
printed over every page, and no prompt or image size stopped them.

A document paperless-gpt failed to read (tagged "paperless-gpt-failed": Ollama
aborts a page with "token repeat limit reached", and the whole document fails
after three tries) is handed to naming once all the same, with the text it
already has, and a note saying so. The note keeps it from going round again.

After naming, it fixes what the naming gets wrong in a way a rule can catch:

- A "Due date" on or before the document's own date is cleared, unless the
  text says "due date", "pay by", "payment due" or "last date for payment"
  (an invoice due the day it is issued is real). The model sometimes copies a
  fine's or bill's own date into it, and rewording its prompt did not stop it.
- A document tagged "travel" loses "shopping": a paid stay or a ticket is not
  shopping. The tag prompt says so and gets it right on the same text in
  tests, yet an Airbnb receipt still came back "travel, shopping" after a
  re-run.
- Runs of spaces in a title become one space. The title prompt's examples
  carry a note after a few spaces, and the model copies the gap
  ("... – 2016   (Arabic)").
- A title's date is removed when a year in it is not in the document's text.
  Undated letters came back with a made-up date ("May 2023") though the
  prompt says never to invent one. Years are looked for as written (also in
  Arabic digits) and as two digits in "05/03/23", "Mar-23" or "2025/26", so a
  real date is kept. A document whose text only gives a Hijri year loses its
  Gregorian date. Each removal leaves a note on the document, and a document
  with that note is not checked again, so a date the owner types in stays.

Those fixes look only at documents paperless-gpt has finished (tagged
paperless-gpt-auto-complete). It prints what it changed and exits 0 either way.
"""

import os
import re
import sys

DONE_TAG = "paperless-gpt-auto-complete"
# Run as root (docker exec's default), a rename made root's folders and a
# search update wrote root's index files; Paperless, running as paperless,
# then could not move files into them, and a save failed with a 500.
ROOT_REFUSED = "after-ai: run as the paperless user: docker exec -u paperless paperless python3 ..."
# new-document's completion tag, and name-document's trigger.
READ_TAG = "ai-read"
NAME_TAG = "ai-name"
FAILED_TAG = "paperless-gpt-failed"
FAILED_NOTE = "after-ai: paperless-gpt could not read this document"
# A cut this big means a page looped to the token cap and lost its own text.
LOST_PAGE_CHARS = 2000
OWN_OCR_HEADING = (
    "\n\n## Paperless's own OCR of every page\n\n"
    "The AI lost some pages to a repeated watermark; this is how Paperless read them.\n\n"
)
# 1-4 lines (with the blank lines after each), then a phrase of 1-8 words,
# that come 10 or more times in a row. A transcript repeated its Arabic and
# English names as a pair of lines.
REPEATED_LINES = re.compile(r"(?m)^((?:[^\n]+\n+){1,4}?)\1{9,}")
REPEATED_PHRASE = re.compile(r"((?:\S+[ \t]+){1,8}?)\1{9,}")
# Only a phrase with letters in it, or long junk ("/////..."), is cut: a wide
# table can hold ten "| 0" or "| ---" cells in a row.
CUTTABLE = re.compile(r"[^\W\d_]|\S{20}")
DUE_FIELD = "Due date"
DUE_WORDS = re.compile(r"due\s*date|pay\s*by|payment\s*due|last\s*date\s*(for|of)\s*payment", re.I)
# A document with the first tag never keeps the second.
EXCLUSIVE_TAGS = [("travel", "shopping")]
# The words a title's date part is made of (title_prompt.tmpl): "3 Jun 2026",
# "30 Sep–4 Oct 2023", "2025–2026", "expires Feb 2029", "bought May 2025".
MONTHS = {"Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"}
DATE_WORDS = {"expires", "bought"}
YEAR = re.compile(r"(?:19|20)\d\d")
# Arabic-Indic and Persian digits, read as 0-9.
DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "0123456789" * 2)
DROPPED_NOTE = "after-ai: removed the date"


def without_repeats(text: str) -> str:
    """The text with each run of repeated lines or a repeated phrase kept once."""
    text = REPEATED_LINES.sub(r"\1", text)
    text = REPEATED_PHRASE.sub(lambda m: m.group(1) if CUTTABLE.search(m.group(1)) else m.group(0), text)
    # Cutting a phrase can leave lines that now repeat.
    return REPEATED_LINES.sub(r"\1", text)


def own_ocr(holder) -> str:
    """Paperless's own OCR of the file (its archive PDF's text layer), or ''."""
    import subprocess

    if not holder.has_archive_version:
        return ""
    out = subprocess.run(
        ["pdftotext", str(holder.archive_path), "-"], capture_output=True, text=True, timeout=120
    ).stdout
    lines = [line.strip() for line in out.replace("\f", "\n").splitlines()]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def clean_text(holder) -> str:
    """The holder's text without repeats, plus Paperless's own OCR when a
    page looped."""
    text = holder.content or ""
    cleaned = without_repeats(text)
    if len(text) - len(cleaned) >= LOST_PAGE_CHARS:
        own = own_ocr(holder)
        if own:
            cleaned += OWN_OCR_HEADING + own
    return cleaned


def hand_off(doc, from_tag, name_tag) -> None:
    """Cleans a document's text and moves it from from_tag to naming."""
    from documents.models import Document
    from documents.search import get_backend

    # The text sits on the root, or on its latest version for a locked
    # original (see text_of).
    latest = Document.global_objects.filter(root_document=doc).order_by("-version_index").first()
    for holder in [doc] + ([latest] if latest else []):
        text = holder.content or ""
        cleaned = clean_text(holder)
        if cleaned == text:
            continue
        holder.content = cleaned
        holder.save(update_fields=["content"])
        added = " (with Paperless's own OCR added)" if OWN_OCR_HEADING in cleaned else ""
        print(f"after-ai: document {holder.pk}: cut repeated text, {len(text)} -> {len(cleaned)} characters{added}.")
        try:
            get_backend().add_or_update(doc)
        except Exception as error:  # noqa: BLE001 - search catches up on its own reindex
            print(f"after-ai: document {doc.pk}: search index not updated ({type(error).__name__}: {error}).")
    # The new tag first: a run that stops between the two leaves the
    # document queued for naming, never with neither tag.
    doc.tags.add(name_tag)
    doc.tags.remove(from_tag)


def hand_to_naming() -> None:
    """Hands every document paperless-gpt has read, and once each one it
    failed to read, on to naming."""
    from documents.models import Document, Note, Tag

    name_tag = Tag.objects.get_or_create(name=NAME_TAG, defaults={"matching_algorithm": 0})[0]
    read_tag = Tag.objects.filter(name=READ_TAG).first()
    for doc in Document.objects.filter(root_document__isnull=True, tags=read_tag) if read_tag else []:
        try:
            hand_off(doc, read_tag, name_tag)
            print(f"after-ai: document {doc.pk}: read, handed to naming.")
        except Exception as error:  # noqa: BLE001 - one bad document must not hold up the rest
            print(f"after-ai: document {doc.pk}: not handed to naming ({type(error).__name__}: {error}).")

    failed_tag = Tag.objects.filter(name=FAILED_TAG).first()
    # Not one that also has DONE_TAG: paperless-gpt named it and Paperless
    # rejected a field, which a second naming would not fix.
    failed = Document.objects.filter(root_document__isnull=True, tags=failed_tag).exclude(tags__name=DONE_TAG)
    for doc in failed if failed_tag else []:
        if Note.objects.filter(document=doc, note__startswith=FAILED_NOTE).exists():
            continue
        # The note first: once handed on, this document is never handed on
        # again, and a naming that fails too stays failed. A hand-off that
        # did not happen takes its note back, so the next run tries again.
        note = Note.objects.create(
            document=doc,
            user=doc.owner,
            note=(
                f"{FAILED_NOTE}, so it was named from the text it already had. "
                "If the name is poor, run it again with rerun-ai.py."
            ),
        )
        try:
            hand_off(doc, failed_tag, name_tag)
            print(f"after-ai: document {doc.pk}: reading failed, handed to naming with the text it had.")
        except Exception as error:  # noqa: BLE001 - one bad document must not hold up the rest
            note.delete()
            print(f"after-ai: document {doc.pk}: not handed to naming ({type(error).__name__}: {error}).")


def text_of(doc) -> str:
    """The document's text, or its latest version's when the root has none (a
    locked original whose unlocked copy holds the text)."""
    from documents.models import Document

    if (doc.content or "").strip():
        return doc.content
    latest = Document.global_objects.filter(root_document=doc).order_by("-version_index").first()
    return (latest.content if latest else "") or ""


def title_date(title: str):
    """Splits "Type – Key – Date (suffix)" into (title without the date, the
    date, the years in it), or None when the last part is not a date."""
    body, suffix = re.match(r"^(.*?)(\s*\([^()]*\))?$", title).groups()
    parts = body.split(" – ")
    if len(parts) < 3:
        return None
    words = [w for w in re.split(r"[\s–-]+", parts[-1]) if w]
    if not words or not all(w in MONTHS or w in DATE_WORDS or re.fullmatch(r"\d{1,2}", w) or YEAR.fullmatch(w) for w in words):
        return None
    years = {w for w in words if YEAR.fullmatch(w)}
    if not years:
        return None
    return " – ".join(parts[:-1]) + (suffix or ""), parts[-1], years


def years_printed(text: str) -> set[str]:
    """Every year the text shows, four-digit or two-digit."""
    text = text.translate(DIGITS)
    found = set(re.findall(r"(?<!\d)((?:19|20)\d\d)(?!\d)", text))
    # 05/03/23, 5.3.23, 05-03-23
    found |= {"20" + y for y in re.findall(r"(?<!\d)\d{1,2}[/.\-]\d{1,2}[/.\-](\d\d)(?!\d)", text)}
    # Mar-23, Mar '23, March 23 (a day read as a year only keeps a date)
    found |= {"20" + y for y in re.findall(r"(?i)\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?[\s'\-]{1,3}(\d\d)(?!\d)", text)}
    # 2025/26, 2025-26
    found |= {y[:2] + yy for y, yy in re.findall(r"(?<!\d)((?:19|20)\d\d)\s*[/\-–]\s*(\d\d)(?!\d)", text)}
    return found


def main() -> None:
    if os.geteuid() == 0:
        print(ROOT_REFUSED)
        return
    sys.path.insert(0, "/usr/src/paperless/src")
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "paperless.settings")
    import django

    django.setup()
    from documents.models import CustomFieldInstance, Document, Note, Tag

    hand_to_naming()

    for keep, drop in EXCLUSIVE_TAGS:
        drop_tag = Tag.objects.filter(name=drop).first()
        if drop_tag is None:
            continue
        both = Document.objects.filter(root_document__isnull=True, tags__name=DONE_TAG).filter(tags__name=keep).filter(tags=drop_tag)
        for doc in both:
            doc.tags.remove(drop_tag)
            print(f"after-ai: document {doc.pk}: removed tag {drop} (it is tagged {keep}).")

    spaced = Document.objects.filter(root_document__isnull=True, tags__name=DONE_TAG, title__regex=r"\s\s")
    for doc in spaced:
        title = re.sub(r"\s+", " ", doc.title).strip()
        print(f"after-ai: document {doc.pk}: title {doc.title!r} -> {title!r}.")
        doc.title = title
        doc.save(update_fields=["title"])

    for doc in Document.objects.filter(root_document__isnull=True, tags__name=DONE_TAG):
        found = title_date(doc.title)
        if found is None or Note.objects.filter(document=doc, note__startswith=DROPPED_NOTE).exists():
            continue
        text = text_of(doc)
        if not text.strip():
            continue
        title, date, years = found
        missing = sorted(years - years_printed(text))
        if not missing:
            continue
        Note.objects.create(
            document=doc,
            user=doc.owner,
            note=(
                f'{DROPPED_NOTE} "{date}" from the title: the text never shows {", ".join(missing)}, '
                "so the AI made it up. If you know the date, type it into the title; it will not be removed again."
            ),
        )
        print(f"after-ai: document {doc.pk}: title {doc.title!r} -> {title!r} ({', '.join(missing)} not in the text).")
        doc.title = title
        doc.save(update_fields=["title"])

    dues = CustomFieldInstance.objects.filter(
        field__name=DUE_FIELD,
        value_date__isnull=False,
        document__tags__name=DONE_TAG,
        document__root_document__isnull=True,
    ).select_related("document")
    for due in dues:
        doc = due.document
        if doc.created is None or due.value_date > doc.created:
            continue
        if DUE_WORDS.search(text_of(doc)):
            continue
        print(f"after-ai: document {doc.pk}: cleared due date {due.value_date} (document date {doc.created}, no due date printed).")
        due.delete()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001 - a fix-up job never fails loudly
        print(f"after-ai: {type(error).__name__}: {error}")
    sys.exit(0)
