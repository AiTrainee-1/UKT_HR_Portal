"""Visitor name and Aadhaar per branch (19 Nov 2026): VisitorVisit keeps the identity given at that visit
(visitor_name, aadhaar_number), so a branch never sees the name / Aadhaar another branch was given for the same phone.
Both nullable (additive; an older release keeps inserting visits without them, which then fall back to the Visitor
row). Every existing visit is filled from its Visitor row in one UPDATE ... FROM (the identity it was shown with until
now). Reversing removes the columns; the backfill step itself reverses as a no-op."""

from django.db import migrations, models

BACKFILL_SQL = """
    UPDATE visitor_visits AS vv
       SET visitor_name = v.name,
           aadhaar_number = v.aadhaar_number
      FROM visitors AS v
     WHERE vv.visitor_id = v.id
       AND vv.visitor_name IS NULL
"""


def backfill_visit_identity(apps, schema_editor):
    """Copies each visit's Visitor name / Aadhaar onto the visit, only where the visit has no name of its own yet (so a
    visit written by the new code in the meantime keeps what was given at it). Bulk SQL, no row-by-row loop."""
    with schema_editor.connection.cursor() as cursor:
        cursor.execute(BACKFILL_SQL)


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0164_outpass_gate_scan_tea_type"),
    ]

    operations = [
        migrations.AddField(
            model_name="visitorvisit",
            name="visitor_name",
            field=models.TextField(blank=True, db_column="visitor_name", null=True),
        ),
        migrations.AddField(
            model_name="visitorvisit",
            name="aadhaar_number",
            field=models.TextField(blank=True, db_column="aadhaar_number", null=True),
        ),
        migrations.RunPython(backfill_visit_identity, migrations.RunPython.noop),
    ]
