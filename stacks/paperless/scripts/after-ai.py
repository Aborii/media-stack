#!/usr/bin/env python3
"""Fixes what paperless-gpt gets wrong in a way a rule can catch, once it has
finished with a document. Run inside the paperless container every 10 minutes
by aborii's user timer (systemd/paperless-after-ai.*), since nothing in
Paperless runs after paperless-gpt writes.

- A "Due date" on or before the document's own date is cleared, unless the
  text says "due date", "pay by", "payment due" or "last date for payment"
  (an invoice due the day it is issued is real). The model sometimes copies a
  fine's or bill's own date into it, and rewording its prompt did not stop it.
- A document tagged "travel" loses "shopping": a paid stay or a ticket is not
  shopping. The tag prompt says so and gets it right on the same text in
  tests, yet an Airbnb receipt still came back "travel, shopping" after a
  re-run.

Only documents paperless-gpt has finished (tagged paperless-gpt-auto-complete)
are looked at. It prints what it changed and exits 0 either way.
"""

import os
import re
import sys

DONE_TAG = "paperless-gpt-auto-complete"
DUE_FIELD = "Due date"
DUE_WORDS = re.compile(r"due\s*date|pay\s*by|payment\s*due|last\s*date\s*(for|of)\s*payment", re.I)
# A document with the first tag never keeps the second.
EXCLUSIVE_TAGS = [("travel", "shopping")]


def main() -> None:
    sys.path.insert(0, "/usr/src/paperless/src")
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "paperless.settings")
    import django

    django.setup()
    from documents.models import CustomFieldInstance, Document, Tag

    for keep, drop in EXCLUSIVE_TAGS:
        drop_tag = Tag.objects.filter(name=drop).first()
        if drop_tag is None:
            continue
        both = Document.objects.filter(root_document__isnull=True, tags__name=DONE_TAG).filter(tags__name=keep).filter(tags=drop_tag)
        for doc in both:
            doc.tags.remove(drop_tag)
            print(f"after-ai: document {doc.pk}: removed tag {drop} (it is tagged {keep}).")

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
        latest = Document.global_objects.filter(root_document=doc).order_by("-version_index").first()
        text = (latest.content if latest and not (doc.content or "").strip() else doc.content) or ""
        if DUE_WORDS.search(text):
            continue
        print(f"after-ai: document {doc.pk}: cleared due date {due.value_date} (document date {doc.created}, no due date printed).")
        due.delete()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001 - a fix-up job never fails loudly
        print(f"after-ai: {type(error).__name__}: {error}")
    sys.exit(0)
