from datetime import datetime, timedelta, timezone

import jwt
from django.conf import settings


def sign_token(payload: dict, expires_in: timedelta = timedelta(days=7)) -> str:
    data = {**payload, "exp": datetime.now(timezone.utc) + expires_in}
    token = jwt.encode(data, settings.JWT_SECRET, algorithm="HS256")
    return token if isinstance(token, str) else token.decode("utf-8")


def verify_token(token: str) -> dict:
    return jwt.decode(token, settings.JWT_SECRET, algorithms=["HS256"])
