#!/usr/bin/env python3
"""Paperless post-consume script: runs once a document or a new version of one
is filed.

A PDF that asks for a password is stored as it came, untouched, so it can be
sent on exactly as received. If a password in the list opens it, Paperless's
own unlock adds an unlocked copy as version 2 of the same document. Content,
search and the AI use the latest version, so they get the readable copy; the
original stays as version 1 in the document's Versions menu. The two are
labelled "Original (locked, as received)" and "Unlocked copy". The document is
tagged "unlocked" with a note saying which password worked. If none does, it
is tagged "locked" with a note, and left out of the AI until it is unlocked.

Every other new document, and every new version (the unlocked copy above
included), is tagged "ai-new", which hands it to paperless-gpt. That is done
here rather than by a Paperless "Document Added" workflow so the locked
original never reaches the AI, and so the tags this adds are on before
paperless-gpt saves its own tag list over them.

It also fills the "Languages" custom field from the text: Arabic by its
script, Latin-script languages with langdetect, main language first, and a
language that is only a stamp or a few words left out. Code rather than the
AI: asked to fill it beside the bill fields, the model added Arabic to
English papers and started inventing due dates.

It always exits 0: a post-consume failure marks the upload as failed in
Paperless, though the document is already stored. Problems are only logged.
"""

import os
import re
import sys
from pathlib import Path

AI_TAG = os.environ.get("AI_TAG", "ai-new")
PASSWORDS = Path(os.environ.get("PDF_PASSWORDS_FILE", "/usr/src/paperless/secrets/pdf-passwords.txt"))
LANGUAGES_FIELD = os.environ.get("LANGUAGES_FIELD", "Languages")
LANGUAGE_NAMES = {
    "ar": "Arabic", "en": "English", "tr": "Turkish", "fr": "French", "de": "German",
    "es": "Spanish", "it": "Italian", "pt": "Portuguese", "nl": "Dutch", "ru": "Russian",
    "fa": "Persian", "ur": "Urdu", "hi": "Hindi", "ms": "Malay", "id": "Indonesian",
}
# Fewer letters than this, or under this share of the text, is a stamp or a
# heading in another language, not a language of the document.
MIN_LETTERS = 40
MIN_SHARE = 0.1


def detect_languages(text: str) -> list[str]:
    """The languages a text is written in, most-used first."""
    arabic = len(re.findall(r"[؀-ۿݐ-ݿ]", text))
    latin_text = " ".join(re.findall(r"[A-Za-zÀ-ɏ]+", text))
    latin = sum(len(w) for w in latin_text.split())
    total = arabic + latin
    if total < MIN_LETTERS:
        return []
    found: list[tuple[int, str]] = []
    if arabic >= MIN_LETTERS and arabic / total >= MIN_SHARE:
        found.append((arabic, "Arabic"))
    if latin >= MIN_LETTERS and latin / total >= MIN_SHARE:
        from langdetect import DetectorFactory, detect

        DetectorFactory.seed = 0  # the same text always gives the same answer
        try:
            code = detect(latin_text)
        except Exception:
            code = "en"
        found.append((latin, LANGUAGE_NAMES.get(code, code)))
    return [name for _, name in sorted(found, reverse=True)]


def passwords() -> list[str]:
    if not PASSWORDS.is_file():
        return []
    lines = (line.rstrip("\r\n") for line in PASSWORDS.read_text(encoding="utf-8").splitlines())
    return [line for line in lines if line and not line.startswith("#")]


def needs_password(path: str) -> bool:
    import pikepdf

    try:
        # Opens with an empty password, as any viewer would: a PDF that only
        # restricts copying or printing does, and is read normally.
        pikepdf.open(path).close()
        return False
    except pikepdf.PasswordError:
        return True


def opening_password(path: str) -> tuple[int, str] | None:
    import pikepdf

    for number, password in enumerate(passwords(), start=1):
        try:
            pikepdf.open(path, password=password).close()
            return number, password
        except pikepdf.PasswordError:
            continue
    return None


ORIGINAL_LABEL = "Original (locked, as received)"
UNLOCKED_LABEL = "Unlocked copy"


def label_versions(root, version) -> None:
    """Names both versions of an unlocked PDF in the Versions menu.

    Paperless's unlock adds the copy with no label, which leaves two unnamed
    versions and no way to tell which one to send as received. Only a version
    that arrives while the document is tagged "unlocked" counts, and a label
    already given (by hand, or by an upload) is kept.
    """
    if not root.tags.filter(name="unlocked").exists():
        return
    if not root.version_label:
        root.version_label = ORIGINAL_LABEL
        root.save(update_fields=["version_label"])
    if not version.version_label:
        version.version_label = UNLOCKED_LABEL
        version.save(update_fields=["version_label"])
    print(f"after-filing: labelled the versions of document {root.pk}.")


def date_from_text(root, version) -> None:
    """Dates a document from its unlocked version's text.

    A locked original has no text, so Paperless dated the document with the
    day it was uploaded, and it reads the date only once, from the original.
    This reads it from the unlocked copy the way Paperless would (the same
    parser, so PAPERLESS_IGNORE_DATES and the date order apply). It only
    replaces the upload-day default: a date changed by hand stays.
    """
    from django.utils import timezone
    from documents.plugins.date_parsing import get_date_parser

    # created is a local date; added is stored in UTC.
    if (root.content or "").strip() or root.created != timezone.localtime(root.added).date():
        return
    with get_date_parser() as parser:
        found = next(parser.parse(version.original_filename, version.content or ""), None)
    if found is None:
        return
    root.created = found.date()
    root.save(update_fields=["created"])
    print(f"after-filing: dated document {root.pk} {root.created} from its unlocked text.")


def set_languages(root, text: str) -> None:
    """Fills the Languages field from text, unless it already has a value."""
    from documents.models import CustomField, CustomFieldInstance

    field = CustomField.objects.filter(name=LANGUAGES_FIELD, data_type="string").first()
    if field is None:
        return
    languages = detect_languages(text)
    if not languages:
        return
    instance, made = CustomFieldInstance.objects.get_or_create(document=root, field=field)
    if instance.value_text and not made:
        return  # set by hand or by an earlier version: keep it
    instance.value_text = ", ".join(languages)[:128]
    instance.save()
    print(f"after-filing: document {root.pk} languages: {instance.value_text}.")


def main() -> None:
    sys.path.insert(0, "/usr/src/paperless/src")
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "paperless.settings")
    import django

    django.setup()
    from documents.bulk_edit import remove_password
    from documents.models import Document, Note, Tag

    def tag(name: str, color: str | None = None) -> Tag:
        defaults = {"matching_algorithm": 0}
        if color:
            defaults["color"] = color
        return Tag.objects.get_or_create(name=name, defaults=defaults)[0]

    doc = Document.global_objects.get(pk=int(os.environ["DOCUMENT_ID"]))
    root = doc.root_document or doc

    locked = (
        doc.root_document is None
        and doc.mime_type == "application/pdf"
        and needs_password(os.environ["DOCUMENT_SOURCE_PATH"])
    )
    if not locked:
        set_languages(root, doc.content or "")
        # A readable new version of a document tagged "locked" is the unlock
        # done by hand later (Actions > Remove password).
        stale = root.tags.filter(name="locked").first()
        if doc.root_document is not None and stale:
            root.tags.remove(stale)
            root.tags.add(tag("unlocked", "#455a64"))
            Note.objects.create(
                document=root,
                user=root.owner,
                note="Unlocked by hand. The original locked file is kept as version 1 (Versions menu).",
            )
        if doc.root_document is not None:
            date_from_text(root, doc)
            # Only the first unlocked copy: a later version of an unlocked
            # document is not the unlocked copy, and is left unnamed.
            if not (root.content or "").strip() and doc.version_index == 1:
                label_versions(root, doc)
        if AI_TAG:
            root.tags.add(tag(AI_TAG))
            print(f"after-filing: tagged document {root.pk} {AI_TAG}.")
        return

    found = opening_password(os.environ["DOCUMENT_SOURCE_PATH"])
    if found is None:
        root.tags.add(tag("locked", "#b71c1c"))
        Note.objects.create(
            document=root,
            user=root.owner,
            note=(
                f"Locked: none of the {len(passwords())} passwords in your PDF password list opens it, "
                "so it has no text and the AI skipped it. Add its password to the list, then use "
                "Actions > Remove password with \"Update document\" (a new version) to unlock it."
            ),
        )
        print(f"after-filing: document {root.pk} is locked and no password in the list opens it.")
        return

    number, password = found
    # Queues the unlocked copy as version 2; its own run of this script then
    # tags the document "ai-new".
    remove_password([root.pk], password=password, update_document=True, user=root.owner)
    root.tags.add(tag("unlocked", "#455a64"))
    Note.objects.create(
        document=root,
        user=root.owner,
        note=(
            f"Unlocked on upload with password {number} of your PDF password list. The original "
            "locked file is kept unchanged as version 1 (Versions menu); version 2 is the unlocked "
            "copy that is read, searched and named."
        ),
    )
    print(f"after-filing: document {root.pk} unlocked with password {number}; queued the unlocked copy as a new version.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001 - never fail an upload over this
        print(f"after-filing: {type(error).__name__}: {error}")
    sys.exit(0)
