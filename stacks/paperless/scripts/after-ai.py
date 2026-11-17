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
- The language at the end of a title is checked against what code knows: the
  "Languages" field (after-filing.py) and whether the text says it is a
  translation ("translation", "sworn", "ترجمة", "tercüme", "çeviri"...). A
  Turkish translation came back "(Arabic translation)", an English one
  "(Arabic)", and an original with its translation "(Arabic + English)".
  With translation words and one language, "(X)" or "(X translation)" becomes
  "(that language translation)"; "(A + B)" becomes "(A, with B translation)",
  or goes, for English beside Arabic with no translation words; "(X)" on an
  English-only paper with no translation words goes. "translation" is then
  tagged exactly when the text has translation words and the title says
  "translation".
- A document whose title names an existing correspondent, exactly or with one
  word more, gets that correspondent and its name in the title. The title's
  Key is the issuer by definition, and the correspondent prompt can still
  pick a listed name the page never shows: a sworn translation printed "Arab
  International Private University" and came back under "Ministry of
  Education Syrian Arab Republic".
  These two rules change a document once, with a note saying what changed,
  and leave it alone after that, so the owner's own edits stay.
- A paper titled "Bank Statement" or "Card Statement" is tagged "bank" and
  "finance" and none of the other topics, and gets the matching document
  type. The tag model tagged what a statement lists: VAT as "tax", card
  purchases as "shopping", a salary credit as "salary" and "work", a premium
  as "insurance". Its correspondent is the bank its title names ("Mashreq
  7933" is Mashreq): an existing correspondent with that name, or one that
  differs only in spacing, case or a "Bank" ("Emirates Islamic Bank"), or a
  new one by that name. The correspondent model wrote one bank three ways
  ("Mashreq", "mashreqbank", "Mashreqbank"). Once per document, with a note.
- A statement title's account or card digits ("Mashreq 7933") stay only when
  the statement's text or its file's name shows them at the end of a number
  ("...7933", "XXXXXX7933"); otherwise they are taken out of the title. The model copied the prompt's example digits
  onto a card whose number it could not read, and wrote a masked "36**".
  Once per document, with a note; it checks the text in code, nobody reads it.
- The document's own date is set from its title's date when the two disagree
  on the year. Paperless reads the date from the text when a paper arrives,
  and on half the papers it found none (the upload day was kept) or the wrong
  one (4 Oct 2026 on a certificate from March 2022), so they were filed under
  the wrong year. The title's date has passed the year check above. A day or
  month the title leaves out is the 1st; a range gives its start; "expires"
  is never a document's date, and nothing is set in the future. A flight,
  ticket or stay is dated in its title by the trip, so its date is only set
  when Paperless kept the upload day. Once per document, with a note.

Those fixes look only at documents paperless-gpt has finished (tagged
paperless-gpt-auto-complete). It prints what it changed and exits 0 either way.

Mail: a document that came from Gmail gets "Sent by" (the sender, name and
address) and "Sent on" (when the email was sent, local time, as text: no
custom field type holds a time). Paperless keeps neither, and the AI soon
replaces the correspondent taken from the sender. Every run lists the mail
each enabled "tag the mail" rule has tagged as filed, and fetches the ones not
handled yet (at most MAIL_BATCH a run). A PDF attachment's SHA-256 is the
checksum Paperless gave the document, so the hash finds it, whatever the
file is called (FAB names all 49 of its statements "EStatement.PDF"). The
attachments are hashed in code, never opened. A field already filled is left
as it is. It also gets "Recipient", the address of the mailbox it was fetched
from (so documents from several connected accounts can be told apart), and
the tag "gmail" ("email" for a mailbox elsewhere). Handled mail is remembered
by Gmail's message id in MAIL_STATE; a mail whose document is not there
(still being consumed) is tried again, and after MAIL_GIVE_UP_DAYS it is let
go. The listing and the ids use Gmail's IMAP extensions.
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
LANGUAGES_FIELD = "Languages"
LANGUAGE_NOTE = "after-ai: corrected the language"
DATE_NOTE = "after-ai: set the document date"
STATEMENT_NOTE = "after-ai: filed as a statement"
DIGITS_NOTE = "after-ai: checked the account digits"
SENT_BY_FIELD = "Sent by"
SENT_ON_FIELD = "Sent on"
RECIPIENT_FIELD = "Recipient"
# Every emailed document gets one: "gmail" for a Gmail mailbox, else "email".
MAIL_TAGS = {"gmail", "email"}
# Paperless's data folder: writable by the paperless user and backed up. A new
# name whenever the step starts filling something more, so every mail is
# visited again once (mail-dated.json predates Recipient and the tag).
MAIL_STATE = "/usr/src/paperless/data/after-ai/mail-filed.json"
MAIL_BATCH = 40
MAIL_GIVE_UP_DAYS = 7
# title_prompt.tmpl's kind 6, and the document type each one gets.
STATEMENT_TYPES = {"Bank Statement": "Bank statement", "Card Statement": "Credit card statement"}
STATEMENT_TAGS = {"bank", "finance"}
# Words that do not tell one bank from another.
BANK_FILLER = {"bank", "the", "pjsc", "psc", "llc", "finance"}
# Tags a statement keeps: they say how it was stored, not what it is about.
KEPT_TAGS = {"unlocked", "locked", "translation", READ_TAG, NAME_TAG} | MAIL_TAGS
# title_prompt.tmpl's kind 12: dated by the trip, not by the paper.
TRAVEL_TYPES = {"Flight", "Ticket", "Hotel"}
MONTH_NUMBER = {m: i for i, m in enumerate(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], 1)}
TRANSLATION_TAG = "translation"
# The same words the title and tag prompts treat as a translation's sign.
TRANSLATION_WORDS = re.compile(r"translat|sworn|ترجم|tercüm|çevir|übersetz|yeminli", re.I)
# "Title – Key – Date (suffix)": the suffix is a language, or two.
SUFFIX = re.compile(r"^(.*?)\s*\(([^()]*)\)$")
LANGUAGE = r"[A-Z][a-z]+"


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


def fixed_suffix(title: str, languages: list[str], translated: bool) -> str:
    """The title with its language suffix made to agree with the detected
    languages and whether the text says it is a translation."""
    m = SUFFIX.match(title)
    if not m:
        return title
    body, inner = m.groups()
    single = languages[0] if len(languages) == 1 else None
    one = re.fullmatch(rf"({LANGUAGE})(?: translation)?", inner)
    if one:
        if translated and single and (one.group(1) != single or not inner.endswith("translation")):
            return f"{body} ({single} translation)"
        if not translated and languages == ["English"] and not inner.endswith("translation"):
            return body
        return title
    two = re.fullmatch(rf"({LANGUAGE})\s*(?:\+|&|/|and)\s*({LANGUAGE})", inner)
    if two:
        a, b = two.groups()
        if translated:
            return f"{body} ({a}, with {b} translation)"
        if {a, b} <= {"English", "Arabic"}:
            return body
    return title


def words(name: str) -> set[str]:
    return set(re.findall(r"\w+", name.lower()))


def known_key(title: str, names: list[str]) -> str | None:
    """The one existing correspondent that the title's Key names, exactly or
    with one word more, or None."""
    parts = SUFFIX.sub(r"\1", title).split(" – ")
    if len(parts) < 3:
        return None
    key = words(parts[1])
    hits = [n for n in names if len(words(n)) >= 2 and words(n) <= key and len(key - words(n)) <= 1]
    return hits[0] if len(hits) == 1 else None


def squashed(name: str) -> str:
    """A bank's name without case, spacing and filler words: "Mashreqbank",
    "mashreq bank" and "Mashreq" are all "mashreq"."""
    joined = re.sub(r"[^a-z]", "", name.lower())
    # Until nothing more comes off: "... Bank PJSC" ends in two of them.
    stripped = True
    while stripped:
        stripped = False
        for word in BANK_FILLER:
            if joined.endswith(word) and len(joined) > len(word):
                joined = joined[: -len(word)]
                stripped = True
    return joined


def without_unshown_digits(title: str, text: str, filename: str = "") -> str:
    """The statement title without its account digits when neither the text
    nor the file's own name shows them as the end of a number ("...5101",
    "XXXXXX7933"; not inside an amount like "17424.00"). A masked "36**"
    never counts."""
    parts = title.split(" – ")
    if len(parts) < 3 or not (text.strip() or filename):
        return title
    m = re.search(r"\s+([\d*xX]{3,})$", parts[1])
    if not m:
        return title
    digits = m.group(1)
    shown = False
    if digits.isdigit():
        ending = re.compile(rf"(?<![.,]){digits}(?![\d.,])")
        shown = bool(ending.search(text.translate(DIGITS)) or ending.search(filename))
    if shown:
        return title
    parts[1] = parts[1][: m.start()].strip()
    return " – ".join(parts)


def statement_bank(title: str) -> str | None:
    """The bank a statement's title names: "Card Statement – Mashreq 7933 –
    Oct 2026" is "Mashreq"."""
    parts = SUFFIX.sub(r"\1", title).split(" – ")
    if len(parts) < 2:
        return None
    bank = re.sub(r"\s+\d{3,}$", "", parts[1]).strip()
    return bank or None


def statement_correspondent(bank: str, current: str | None, names: list[str]) -> str:
    """The correspondent a statement from this bank belongs under."""
    exact = [n for n in names if n.lower() == bank.lower()]
    if exact:
        return exact[0]
    if current and squashed(current) == squashed(bank):
        return current
    alike = [n for n in names if squashed(n) == squashed(bank)]
    return alike[0] if len(alike) == 1 else bank


def date_of_title(title: str):
    """The date a title's date part stands for (its start, for a range), or
    None when it has none or it is an expiry."""
    import datetime

    found = title_date(title)
    if found is None:
        return None
    part = found[1]
    if part.startswith("expires"):
        return None
    iso = re.fullmatch(r"((?:19|20)\d\d)-(\d\d)-(\d\d)", part)
    tokens = [t for t in re.split(r"[\s–-]+", part) if t and t not in DATE_WORDS]
    if iso:
        year, month, day = (int(x) for x in iso.groups())
    else:
        year = int(next(t for t in tokens if YEAR.fullmatch(t)))
        months = [MONTH_NUMBER[t] for t in tokens if t in MONTH_NUMBER]
        month = months[0] if months else 1
        # A day counts only when it comes before the first month: "30 Sep–4 Oct 2023".
        first_month = next((i for i, t in enumerate(tokens) if t in MONTH_NUMBER), None)
        days = [int(t) for t in tokens[:first_month] if re.fullmatch(r"\d{1,2}", t)] if first_month is not None else []
        day = days[0] if days else 1
    try:
        return datetime.date(year, month, day)
    except ValueError:
        return None


def gmail_ids(M, uids: list[str]) -> dict[str, str]:
    """IMAP uid -> Gmail's message id, which stays the same across folders and
    sessions. Each reply line is read for both numbers, whatever their order."""
    _, data = M.client.uid("FETCH", ",".join(uids), "(X-GM-MSGID)")
    ids = {}
    for item in data:
        line = item if isinstance(item, bytes) else item[0] if isinstance(item, tuple) else b""
        uid, msgid = re.search(rb"\bUID (\d+)", line), re.search(rb"X-GM-MSGID (\d+)", line)
        if uid and msgid:
            ids[uid.group(1).decode()] = msgid.group(1).decode()
    return ids


def mail_matches(M, uids: list[str]):
    """For each mail, (uid, its date, sender, and the documents its PDF
    attachments became). Hashes the attachments; never opens them."""
    import datetime
    import hashlib

    from documents.models import Document

    for msg in M.fetch(f"UID {','.join(uids)}", mark_seen=False, bulk=True):
        sums = [hashlib.sha256(a.payload).hexdigest() for a in msg.attachments if (a.filename or "").lower().endswith(".pdf")]
        docs = list(Document.objects.filter(root_document__isnull=True, checksum__in=sums)) if sums else []
        sender = msg.from_values.full if msg.from_values else msg.from_
        # imap_tools gives 1900-01-01 for a mail with no Date header, and a
        # naive time for one without an offset.
        when = msg.date
        if when and when.year < 1971:
            when = None
        elif when and when.tzinfo is None:
            when = when.replace(tzinfo=datetime.timezone.utc)
        yield msg.uid, when, sender, docs


def fill_sent_fields() -> None:
    """Fills Sent by, Sent on and Recipient, and tags documents that came from
    mail."""
    import datetime
    import json
    from pathlib import Path
    from zoneinfo import ZoneInfo

    from django.conf import settings
    from imap_tools import AND, MailBox

    from documents.models import CustomField, CustomFieldInstance, Tag
    from paperless_mail.models import MailRule

    sent_by = CustomField.objects.get_or_create(name=SENT_BY_FIELD, defaults={"data_type": "string"})[0]
    sent_on = CustomField.objects.get_or_create(name=SENT_ON_FIELD, defaults={"data_type": "string"})[0]
    recipient = CustomField.objects.get_or_create(name=RECIPIENT_FIELD, defaults={"data_type": "string"})[0]
    state_file = Path(MAIL_STATE)
    done = set(json.loads(state_file.read_text())) if state_file.exists() else set()
    local = ZoneInfo(settings.TIME_ZONE)
    now = datetime.datetime.now(datetime.timezone.utc)

    for rule in MailRule.objects.filter(enabled=True, action=5).select_related("account"):
        a = rule.account
        mail_tag = Tag.objects.get_or_create(
            name="gmail" if "gmail" in a.imap_server.lower() else "email", defaults={"matching_algorithm": 0}
        )[0]
        with MailBox(a.imap_server, a.imap_port).login(a.username, a.password) as M:
            M.folder.set(rule.folder)
            uids = M.uids(AND(gmail_label=rule.action_parameter))
            if not uids:
                continue
            ids = gmail_ids(M, uids)
            todo = [u for u in uids if u in ids and ids[u] not in done][:MAIL_BATCH]
            if not todo:
                continue
            for uid, when, sender, docs in mail_matches(M, todo):
                msgid = ids[uid]
                if not docs:
                    # Undated, it cannot be aged: let it go rather than fetch it forever.
                    if not when or now - when > datetime.timedelta(days=MAIL_GIVE_UP_DAYS):
                        done.add(msgid)
                    continue
                stamp = when.astimezone(local).strftime("%Y-%m-%d %H:%M") if when else ""
                for doc in docs:
                    for field, value in ((sent_by, sender), (sent_on, stamp), (recipient, a.username)):
                        if value and not CustomFieldInstance.objects.filter(document=doc, field=field).exists():
                            CustomFieldInstance.objects.create(document=doc, field=field, value_text=value)
                    doc.tags.add(mail_tag)
                    print(f"after-ai: document {doc.pk}: sent by {sender} on {stamp}, to {a.username}.")
                done.add(msgid)
    state_file.parent.mkdir(parents=True, exist_ok=True)
    state_file.write_text(json.dumps(sorted(done)))


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
    try:
        fill_sent_fields()
    except Exception as error:  # noqa: BLE001 - Gmail being down must not stop the fixes below
        print(f"after-ai: Sent by / Sent on not filled ({type(error).__name__}: {error}).")

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

    from documents.models import Correspondent

    translation_tag = Tag.objects.filter(name=TRANSLATION_TAG).first()
    names = list(Correspondent.objects.values_list("name", flat=True))
    for doc in Document.objects.filter(root_document__isnull=True, tags__name=DONE_TAG):
        # Once per document, like the date rule: edits made after it stay.
        if Note.objects.filter(document=doc, note__startswith=LANGUAGE_NOTE).exists():
            continue
        text = text_of(doc)
        field = CustomFieldInstance.objects.filter(document=doc, field__name=LANGUAGES_FIELD).first()
        languages = [x.strip() for x in (field.value_text or "").split(",") if x.strip()] if field else []
        translated = bool(TRANSLATION_WORDS.search(text))
        changes = []
        title = fixed_suffix(doc.title, languages, translated) if languages else doc.title
        name = known_key(title, names)
        if name and (doc.correspondent is None or doc.correspondent.name != name):
            parts = title.split(" – ")
            title = " – ".join([parts[0], name, *parts[2:]])
            was = doc.correspondent.name if doc.correspondent else "none"
            doc.correspondent = Correspondent.objects.get(name=name)
            doc.save(update_fields=["correspondent"])
            changes.append(f"correspondent {name}, which the title named (was {was})")
        elif name and name not in title:
            parts = title.split(" – ")
            title = " – ".join([parts[0], name, *parts[2:]])
        if title != doc.title:
            changes.append(f"title {doc.title!r} -> {title!r} (languages found: {', '.join(languages)})")
            doc.title = title
            doc.save(update_fields=["title"])
        if translation_tag is not None:
            wanted = translated and "translation)" in doc.title
            has = doc.tags.filter(pk=translation_tag.pk).exists()
            if wanted and not has:
                doc.tags.add(translation_tag)
                changes.append(f"tagged {TRANSLATION_TAG}")
            elif has and not translated:
                doc.tags.remove(translation_tag)
                changes.append(f"removed tag {TRANSLATION_TAG} (the text never says it is a translation)")
        if changes:
            Note.objects.create(
                document=doc,
                user=doc.owner,
                note=f"{LANGUAGE_NOTE} and translation details: {'; '.join(changes)}. Edits made after this are kept.",
            )
            print(f"after-ai: document {doc.pk}: {'; '.join(changes)}.")

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

    from documents.models import DocumentType

    for kind, type_name in STATEMENT_TYPES.items():
        for doc in Document.objects.filter(root_document__isnull=True, tags__name=DONE_TAG, title__startswith=f"{kind} – "):
            if Note.objects.filter(document=doc, note__startswith=STATEMENT_NOTE).exists():
                continue
            names = {t.name for t in doc.tags.all()}
            drop = sorted(n for n in names if n not in STATEMENT_TAGS | KEPT_TAGS and not n.startswith("paperless-gpt"))
            add = sorted(STATEMENT_TAGS - names)
            changes = []
            if drop:
                doc.tags.remove(*Tag.objects.filter(name__in=drop))
                changes.append(f"removed {', '.join(drop)}")
            if add:
                doc.tags.add(*Tag.objects.filter(name__in=add))
                changes.append(f"added {', '.join(add)}")
            wanted = DocumentType.objects.filter(name=type_name).first()
            if wanted and doc.document_type_id != wanted.pk:
                doc.document_type = wanted
                doc.save(update_fields=["document_type"])
                changes.append(f"type {type_name}")
            bank = statement_bank(doc.title)
            current = doc.correspondent.name if doc.correspondent else None
            if bank:
                name = statement_correspondent(bank, current, list(Correspondent.objects.values_list("name", flat=True)))
                if name != current:
                    doc.correspondent = Correspondent.objects.get_or_create(
                        name=name, defaults={"matching_algorithm": 0, "owner": doc.owner}
                    )[0]
                    doc.save(update_fields=["correspondent"])
                    changes.append(f"correspondent {name} (was {current or 'none'})")
            # Even with nothing to change: each statement is decided once, so a
            # tag the owner adds later is never taken off again.
            Note.objects.create(
                document=doc,
                user=doc.owner,
                note=f"{STATEMENT_NOTE}: {'; '.join(changes) or 'nothing to change'}. Edits made after this are kept.",
            )
            if changes:
                print(f"after-ai: document {doc.pk}: statement, {'; '.join(changes)}.")

    for kind in STATEMENT_TYPES:
        for doc in Document.objects.filter(root_document__isnull=True, tags__name=DONE_TAG, title__startswith=f"{kind} – "):
            if Note.objects.filter(document=doc, note__startswith=DIGITS_NOTE).exists():
                continue
            title = without_unshown_digits(doc.title, text_of(doc), doc.original_filename or "")
            done = f"took the digits out of {doc.title!r}: the statement never shows them" if title != doc.title else "the digits are in the statement"
            Note.objects.create(document=doc, user=doc.owner, note=f"{DIGITS_NOTE}: {done}.")
            if title != doc.title:
                print(f"after-ai: document {doc.pk}: title {doc.title!r} -> {title!r} (digits not in the text).")
                doc.title = title
                doc.save(update_fields=["title"])

    from django.utils import timezone

    today = timezone.localdate()
    for doc in Document.objects.filter(root_document__isnull=True, tags__name=DONE_TAG):
        when = date_of_title(doc.title)
        if when is None or when > today or doc.created is None:
            continue
        if str(doc.created.year) in title_date(doc.title)[2]:
            continue
        # A trip's title is dated by the trip, its paper by the booking: keep a
        # booking date Paperless found, and fill in only the upload day.
        if doc.title.split(" – ")[0] in TRAVEL_TYPES and doc.created != timezone.localtime(doc.added).date():
            continue
        if Note.objects.filter(document=doc, note__startswith=DATE_NOTE).exists():
            continue
        Note.objects.create(
            document=doc,
            user=doc.owner,
            note=(
                f"{DATE_NOTE} to {when} from the title (it was {doc.created}). "
                "A date you set after this is kept."
            ),
        )
        print(f"after-ai: document {doc.pk}: date {doc.created} -> {when} (from the title).")
        doc.created = when
        doc.save(update_fields=["created"])

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
