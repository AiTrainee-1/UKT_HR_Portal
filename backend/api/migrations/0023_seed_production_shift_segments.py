from django.db import migrations


DEFAULT_SEGMENTS = [
    ("Morning 1", "08:30", "10:30", "0.25", 1),
    ("Morning 2", "10:30", "12:45", "0.25", 2),
    ("Afternoon 1", "13:30", "15:30", "0.25", 3),
    ("Afternoon 2", "15:30", "17:30", "0.25", 4),
    ("Evening", "17:30", "20:00", "0.50", 5),
]


def seed_segments(apps, schema_editor):
    ProductionShiftSegment = apps.get_model("api", "ProductionShiftSegment")
    if ProductionShiftSegment.objects.exists():
        return
    for label, start, end, value, order in DEFAULT_SEGMENTS:
        ProductionShiftSegment.objects.create(
            label=label, start_time=start, end_time=end, shift_value=value, order=order, is_active=True,
        )


def noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0022_productionshiftconfig_productionshiftsegment_and_more'),
    ]

    operations = [
        migrations.RunPython(seed_segments, noop),
    ]
