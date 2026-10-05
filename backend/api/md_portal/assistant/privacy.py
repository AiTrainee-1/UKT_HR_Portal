"""Keeping people's identities out of what is sent to Gemini.

The free Gemini tier may use prompts and answers to improve Google's products and may let human reviewers read them, so
the assistant sends *aggregates by default* and, in privacy mode (the default), replaces every employee's name with a
token (``@emp-1042``) before anything leaves the server: in tool results, and in the MD's own question ("how is Ravi
Kumar doing?" becomes "how is @emp-1042 doing?"). The model reasons with the tokens and passes them back to tools; the
server turns them into the real identifier for the tool call and puts the real names back into the answer the MD reads.

Always, privacy mode or not, contact and identity details the assistant has no business seeing are dropped from tool
results: phone numbers, e-mail, addresses, dates of birth, bank and government ids.

Nothing here is a guarantee against a name written inside free text that is not in the employee list; it removes the
identifiers the system knows about, which is the realistic goal. Paid-tier terms (no training on prompts) are the real
fix for production use: see md-portal.md section 7.
"""

from __future__ import annotations

import re
from typing import Any

from ..common import MdParamError  # noqa: F401  (re-exported for callers that catch parameter errors)
from .tools_base import STANDARD_PERSON_FIELDS

#: dropped from every tool result, whatever the privacy mode
PII_KEYS = frozenset(
    {
        "phone",
        "mobile",
        "email",
        "address",
        "dob",
        "dateOfBirth",
        "date_of_birth",
        "aadhaar",
        "aadhar",
        "pan",
        "bankAccount",
        "accountNumber",
        "ifsc",
        "photoUrl",
        "emergencyContact",
        "password",
        "token",
    }
)
#: identifiers that point at a person: removed from a row once its name has been replaced by a token
IDENTIFIER_KEYS = frozenset({"code", "employeeCode", "unitCode", "empCode"})

TOKEN_PATTERN = re.compile(r"@(emp|user|visitor|person)-(\d+)")
# A model asked to write for a voice sometimes drops the "@emp-" and says "employee 301": still our token.
EMPLOYEE_PHRASE = re.compile(r"\b(?:employee|emp)s?\s*#?\s*(\d+)\b", re.IGNORECASE)


class Pseudonymizer:
    """Per-question mapping between people and tokens. ``enabled=False`` still drops the PII keys."""

    def __init__(self, enabled: bool = True):
        self.enabled = enabled
        self._real: dict[str, str] = {}  # token -> real name (to put names back for the MD)
        self._emp_ids: dict[str, int] = {}  # token -> employee id (to turn a token in tool arguments into the real id)
        self._counters = {"user": 0, "visitor": 0, "person": 0}
        self._by_name: dict[tuple[str, str], str] = {}  # (kind, name) -> token
        self._name_index: dict[str, tuple[str, int]] | None = None

    # -- tokens ------------------------------------------------------------------------------------------------------

    def employee_token(self, employee_id: int, name: str) -> str:
        token = f"@emp-{employee_id}"
        self._real.setdefault(token, name)
        self._emp_ids[token] = int(employee_id)
        return token

    def _named_token(self, kind: str, name: str) -> str:
        key = (kind, name)
        if key not in self._by_name:
            self._counters[kind] += 1
            token = f"@{kind}-{self._counters[kind]}"
            self._by_name[key] = token
            self._real[token] = name
        return self._by_name[key]

    # -- the name index (employees and HR accounts whose full name appears in text) ---------------------------------

    def _names(self) -> dict[str, tuple[str, int]]:
        if self._name_index is None:
            from ...models import Employee, HRUser

            index: dict[str, tuple[str, int]] = {}
            for pk, first, last in Employee.objects.values_list("id", "first_name", "last_name"):
                full = _normal(f"{first} {last}")
                if full and " " in full:
                    index.setdefault(full, ("emp", pk))
            for pk, full_name in HRUser.objects.exclude(full_name__isnull=True).values_list("id", "full_name"):
                full = _normal(full_name)
                if full and " " in full:
                    index.setdefault(full, ("user", pk))
            self._name_index = index
        return self._name_index

    def protect_text(self, text: str) -> str:
        """Replace any known full name in free text (the question, an audit-log description) with its token."""
        if not self.enabled or not text:
            return text
        index = self._names()
        if not index:
            return text
        # Words are runs of anything that is not whitespace or sentence punctuation (so "Devi?" is "Devi", and Tamil or
        # Hindi words with combining vowel signs stay whole).
        words = list(re.finditer(r"[^\s,;:()\[\]\"'?!<>{}|/\\]+", text))
        out: list[str] = []
        i, last_end = 0, 0
        while i < len(words):
            replaced = False
            for span in (4, 3, 2):  # longest name first
                if i + span > len(words):
                    continue
                start, end = words[i].start(), words[i + span - 1].end()
                chunk = text[start:end].rstrip(".")  # a full stop ending the sentence is not part of the name
                hit = index.get(_normal(chunk))
                if hit:
                    kind, pk = hit
                    token = self.employee_token(pk, chunk) if kind == "emp" else self._named_token("user", chunk)
                    out.append(text[last_end:start])
                    out.append(token)
                    last_end = start + len(chunk)
                    i += span
                    replaced = True
                    break
            if not replaced:
                i += 1
        out.append(text[last_end:])
        return "".join(out)

    # -- tool results (out to the model) ----------------------------------------------------------------------------

    def protect(self, node: Any, person_fields: tuple[str, ...] = ()) -> Any:
        """A copy of a tool result with PII removed and, in privacy mode, people replaced by tokens."""
        fields = set(STANDARD_PERSON_FIELDS) | set(person_fields)
        return self._walk(node, fields)

    def _walk(self, node: Any, fields: set[str]) -> Any:
        if isinstance(node, dict):
            has_person = self.enabled and any(isinstance(node.get(k), str) and node.get(k) for k in fields if k in node)
            emp_id = node.get("employeeId") if isinstance(node.get("employeeId"), int) else None
            out: dict = {}
            for key, value in node.items():
                if key in PII_KEYS:
                    continue
                if has_person and key in IDENTIFIER_KEYS:
                    continue
                if has_person and key in fields and isinstance(value, str) and value:
                    out[key] = self._person_token(key, value, emp_id)
                elif has_person and key == "employeeId" and emp_id is not None:
                    out[key] = f"@emp-{emp_id}"
                else:
                    out[key] = self._walk(value, fields)
            return out
        if isinstance(node, list):
            return [self._walk(x, fields) for x in node]
        if isinstance(node, str):
            return self.protect_text(node)
        return node

    def _person_token(self, key: str, value: str, emp_id: int | None) -> str:
        if emp_id is not None and key in ("name", "employeeName", "fullName"):
            return self.employee_token(emp_id, value)
        if key == "visitorName":
            return self._named_token("visitor", value)
        if key in ("userName", "user_name", "managerName", "approvedBy", "requestedBy"):
            return self._named_token("user", value)
        hit = self._names().get(_normal(value))
        if hit and hit[0] == "emp":
            return self.employee_token(hit[1], value)
        return self._named_token("person", value)

    # -- from the model (tool arguments, the answer) ----------------------------------------------------------------

    def reveal_args(self, args: Any) -> Any:
        """Tool arguments with employee tokens turned into the employee id the tools accept."""
        if isinstance(args, dict):
            return {k: self.reveal_args(v) for k, v in args.items()}
        if isinstance(args, list):
            return [self.reveal_args(x) for x in args]
        if isinstance(args, str):
            match = TOKEN_PATTERN.fullmatch(args.strip())
            if match and match.group(1) == "emp":
                return match.group(2)
            return TOKEN_PATTERN.sub(self._swap_for_id, args)
        return args

    def _swap_for_id(self, match: re.Match) -> str:
        employee_id = self._emp_ids.get(match.group(0))
        return str(employee_id) if employee_id is not None else match.group(0)

    def restore(self, text: str) -> str:
        """Put the real names back for the MD. A token the server never issued becomes a neutral phrase."""
        if not text:
            return text

        def swap(match: re.Match) -> str:
            token = match.group(0)
            if token in self._real:
                return self._real[token]
            return {"emp": "an employee", "user": "a user", "visitor": "a visitor"}.get(match.group(1), "a person")

        restored = TOKEN_PATTERN.sub(swap, text)
        return EMPLOYEE_PHRASE.sub(
            lambda m: self._real.get(f"@emp-{m.group(1)}", m.group(0)), restored
        )  # only an id this question really issued

    def restore_deep(self, node: Any) -> Any:
        if isinstance(node, dict):
            return {k: self.restore_deep(v) for k, v in node.items()}
        if isinstance(node, list):
            return [self.restore_deep(x) for x in node]
        if isinstance(node, str):
            return self.restore(node)
        return node

    @property
    def tokens_issued(self) -> int:
        return len(self._real)


def _normal(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[.\-_]", " ", text or "")).strip().lower()
