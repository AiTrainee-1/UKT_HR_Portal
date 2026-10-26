"""Data migration: no WhatsApp message carries the Employee Web App link any more.

The two approval messages ("Approval - Approved" / "Approval - Rejected") used to end their detail lines with
"View request: {{link}}", and HR could keep that line in the wording they saved from the editor (WhatsAppMessageTemplate
.message_body). The {{link}} placeholder is gone from the catalogue now, so a saved body that still names it would be
refused by the editor and, if it were ever sent, lose the line anyway (whatsapp_service.render_message drops it).

This removes the WHOLE LINE that holds {{link}} (whatever label or emoji it carries) from every stored body, and a
blank line that the removal leaves doubled (or dangling at the start or the end) goes with it. Nothing else in a body is
touched: not its other lines, not its other blank lines, not its line endings. A body made only of that line becomes
blank, which means "use the built-in wording".

It is idempotent (a body without {{link}} is never changed, so running it again changes nothing), only rows that
contain the placeholder are written, and reversing it is a no-op (the removed line cannot be known again).
"""

import re

from django.db import migrations

# The same spelling the renderer accepts: {{link}} with optional spaces inside the braces.
LINK = re.compile(r"\{\{\s*link\s*\}\}")


def strip_link_lines(body: str) -> str:
    """`body` without the lines that name {{link}}, and without the blank line that removal leaves doubled."""
    if not body or not LINK.search(body):
        return body
    kept: list[str] = []
    after_removed_line = False
    for line in body.split("\n"):
        if LINK.search(line):
            after_removed_line = True
            continue
        # A blank line straight after a removed line is dropped when it would sit next to another blank line (or
        # at the very top), so the gap that held the line closes instead of doubling.
        if after_removed_line and not line.strip() and (not kept or not kept[-1].strip()):
            continue
        after_removed_line = False
        kept.append(line)
    if after_removed_line:
        # The removed line was the last one: do not leave the blank line that separated it dangling.
        while kept and not kept[-1].strip():
            kept.pop()
    return "\n".join(kept)


def forwards(apps, schema_editor):
    WhatsAppMessageTemplate = apps.get_model("api", "WhatsAppMessageTemplate")
    for row in WhatsAppMessageTemplate.objects.filter(message_body__contains="link"):
        cleaned = strip_link_lines(row.message_body)
        if cleaned != row.message_body:
            # update(), not save(): HR's "last edited" time should not move because of a clean-up.
            WhatsAppMessageTemplate.objects.filter(pk=row.pk).update(message_body=cleaned)


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0129_prod_bonus_copy"),
    ]

    operations = [
        migrations.RunPython(forwards, migrations.RunPython.noop),
    ]
