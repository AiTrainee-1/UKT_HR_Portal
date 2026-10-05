"""Keeping people's identities out of what is sent to Gemini (md_portal/assistant/privacy.py) and shaping results."""

from django.test import SimpleTestCase, TestCase

from .md_portal.assistant.privacy import Pseudonymizer
from .md_portal.assistant.shaping import MAX_CHARS, compact
from .models import Branch, Employee, HRUser


class Tokens(TestCase):
    def test_a_row_with_a_name_loses_its_name_code_and_contact_details(self):
        p = Pseudonymizer()
        row = {
            "employeeId": 7,
            "name": "Ravi Kumar",
            "code": "E-007",
            "phone": "98400",
            "email": "r@x.in",
            "department": "Stitching",
            "days": 4,
        }
        out = p.protect({"rows": [row]})
        self.assertEqual(
            out["rows"][0], {"employeeId": "@emp-7", "name": "@emp-7", "department": "Stitching", "days": 4}
        )

    def test_contact_details_are_dropped_even_with_privacy_mode_off(self):
        p = Pseudonymizer(enabled=False)
        out = p.protect(
            {
                "name": "Ravi Kumar",
                "employeeId": 7,
                "phone": "98400",
                "dateOfBirth": "1990-01-01",
                "bankAccount": "123",
                "dept": "x",
            }
        )
        self.assertEqual(out, {"name": "Ravi Kumar", "employeeId": 7, "dept": "x"})

    def test_users_and_visitors_get_stable_tokens_per_name(self):
        p = Pseudonymizer()
        out = p.protect(
            [
                {"userName": "priya", "n": 1},
                {"userName": "priya", "n": 2},
                {"userName": "anand", "n": 3},
                {"visitorName": "V. Sharma"},
            ]
        )
        self.assertEqual([r.get("userName") for r in out[:3]], ["@user-1", "@user-1", "@user-2"])
        self.assertEqual(out[3]["visitorName"], "@visitor-1")

    def test_a_tool_can_declare_its_own_person_fields(self):
        p = Pseudonymizer()
        out = p.protect({"approved_by": "Ravi Kumar", "n": 1}, person_fields=("approved_by",))
        self.assertTrue(out["approved_by"].startswith("@person-"))

    def test_a_token_in_tool_arguments_becomes_the_real_id_and_other_text_is_untouched(self):
        p = Pseudonymizer()
        p.employee_token(1042, "Ravi Kumar")
        self.assertEqual(
            p.reveal_args({"employee": "@emp-1042", "note": "see @emp-1042 today", "limit": 5, "x": ["@emp-1042"]}),
            {"employee": "1042", "note": "see 1042 today", "limit": 5, "x": ["1042"]},
        )
        self.assertEqual(p.reveal_args("@emp-9"), "9")  # a token alone is an id even if never issued
        self.assertEqual(p.reveal_args("plain"), "plain")

    def test_names_come_back_for_the_md_and_a_made_up_token_is_neutral(self):
        p = Pseudonymizer()
        p.employee_token(1042, "Ravi Kumar")
        self.assertEqual(
            p.restore("@emp-1042 was absent; so was @emp-77."), "Ravi Kumar was absent; so was an employee."
        )
        self.assertEqual(p.restore("no tokens here"), "no tokens here")
        self.assertEqual(p.restore_deep({"a": ["@emp-1042"], "n": 3}), {"a": ["Ravi Kumar"], "n": 3})

    def test_a_model_that_writes_employee_301_for_the_voice_still_gets_the_name_back(self):
        p = Pseudonymizer()
        p.employee_token(301, "Ananthakumar R")
        p.employee_token(69, "Babu B")
        spoken = "The most absences are employee 301, Employee #69 and employee 999, each with twenty one days."
        self.assertEqual(
            p.restore(spoken),
            "The most absences are Ananthakumar R, Babu B and employee 999, each with twenty one days.",
        )  # 999 was never issued in this question, so it is left alone
        self.assertEqual(
            p.restore("We have 21 employees and employee count 5"), "We have 21 employees and employee count 5"
        )

    def test_a_disabled_pseudonymizer_leaves_text_alone(self):
        self.assertEqual(Pseudonymizer(enabled=False).protect_text("Ravi Kumar was late"), "Ravi Kumar was late")


class NamesInFreeText(TestCase):
    def setUp(self):
        branch = Branch.objects.create(name="P Unit", code="PU1")
        self.ravi = Employee.objects.create(employee_code="R1", first_name="Ravi", last_name="Kumar", branch=branch)
        Employee.objects.create(employee_code="S1", first_name="Sita", last_name="Devi", branch=branch)
        self.hr = HRUser.objects.create(username="priya", password_hash="x", full_name="Priya Raman")

    def test_a_full_name_in_the_question_becomes_a_token(self):
        p = Pseudonymizer()
        text = p.protect_text("How was Ravi Kumar's attendance, and what about Sita Devi?")
        self.assertEqual(
            text,
            f"How was @emp-{self.ravi.id}'s attendance, and what about @emp-{Employee.objects.get(employee_code='S1').id}?",
        )
        self.assertEqual(p.restore(text), "How was Ravi Kumar's attendance, and what about Sita Devi?")

    def test_matching_ignores_case_and_punctuation_and_needs_the_whole_name(self):
        p = Pseudonymizer()
        self.assertIn("@emp-", p.protect_text("ravi  kumar?"))
        self.assertEqual(p.protect_text("Ravi alone is a common first name"), "Ravi alone is a common first name")

    def test_hr_account_names_in_log_text_are_tokenised_too(self):
        p = Pseudonymizer()
        out = p.protect({"description": "Approved leave. Done by Priya Raman at 10:00"})
        self.assertNotIn("Priya", out["description"])
        self.assertIn("@user-1", out["description"])

    def test_a_name_in_a_person_field_without_an_id_is_matched_to_the_employee(self):
        p = Pseudonymizer()
        out = p.protect({"name": "Ravi Kumar", "days": 2})
        self.assertEqual(out["name"], f"@emp-{self.ravi.id}")


class Shaping(SimpleTestCase):
    def test_provenance_nulls_timing_and_noise_are_removed_and_floats_rounded(self):
        out = compact(
            {
                "a": 1.23456,
                "b": None,
                "tookMs": 12,
                "generatedAt": "x",
                "provenance": [{"caveats": ["Partial data."]}],
                "n": {"c": 2.0},
            }
        )
        self.assertEqual(out, {"a": 1.23, "n": {"c": 2.0}, "caveats": ["Partial data."]})

    def test_long_lists_are_cut_to_fit_and_say_so(self):
        rows = [{"name": f"person {i}", "note": "x" * 120, "days": i} for i in range(200)]
        out = compact({"rows": rows})
        self.assertLessEqual(len(str(out)), MAX_CHARS + 500)
        self.assertLess(len(out["rows"]), 200)
        self.assertIn("left out", out["_truncated"])

    def test_a_small_result_is_not_marked_truncated(self):
        self.assertNotIn("_truncated", compact({"rows": [{"a": 1}] * 5}))

    def test_long_strings_are_shortened(self):
        self.assertTrue(compact({"s": "y" * 1000})["s"].endswith("…"))
