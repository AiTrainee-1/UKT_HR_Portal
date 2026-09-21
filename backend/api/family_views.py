"""
Family & Dependents -read-only, HR-managed list backing the mobile Employee
Profile screen's "Family & Dependents" card (member count + insurance
nominee / health scheme coverage per dependent). Employees can view their own
list but there is no self-service add/edit here yet -HR maintains it via the
Django admin, same as bank/PF/compliance fields on Employee itself.
"""
from __future__ import annotations

from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .auth import get_token_employee_id, require_auth
from .models import FamilyDependent
from .serializers import family_dependent_json


@api_view(["GET"])
@require_auth
def my_family(request: Request) -> Response:
    employee_id = get_token_employee_id(request)
    if not employee_id:
        return Response({"error": "Employee access required"}, status=403)

    dependents = FamilyDependent.objects.filter(employee_id=employee_id).order_by("id")
    return Response({"dependents": [family_dependent_json(d) for d in dependents]})
