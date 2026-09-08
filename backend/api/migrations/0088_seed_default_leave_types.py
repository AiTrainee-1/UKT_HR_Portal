from django.db import migrations


DEFAULT_LEAVE_TYPES = [
    {"name": "Annual Leave", "code": "AL", "max_days_per_year": 18, "is_paid": True},
    {"name": "Sick Leave", "code": "SL", "max_days_per_year": 12, "is_paid": True},
    {"name": "Casual Leave", "code": "CL", "max_days_per_year": 12, "is_paid": True},
    {"name": "Emergency Leave", "code": "EL", "max_days_per_year": 6, "is_paid": True},
    {"name": "Maternity Leave", "code": "ML", "max_days_per_year": 180, "is_paid": True, "applicable_gender": "female"},
    {"name": "Paternity Leave", "code": "PL", "max_days_per_year": 15, "is_paid": True, "applicable_gender": "male"},
]


def seed_leave_types(apps, schema_editor):
    LeaveType = apps.get_model("api", "LeaveType")
    if LeaveType.objects.exists():
        return
    for entry in DEFAULT_LEAVE_TYPES:
        LeaveType.objects.create(
            name=entry["name"],
            code=entry["code"],
            max_days_per_year=entry["max_days_per_year"],
            is_paid=entry["is_paid"],
            applicable_gender=entry.get("applicable_gender", "all"),
            is_active=True,
        )


def noop_reverse(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("api", "0087_attendancedayrecord_is_half_day_leave_and_more"),
    ]

    operations = [
        migrations.RunPython(seed_leave_types, noop_reverse),
    ]
