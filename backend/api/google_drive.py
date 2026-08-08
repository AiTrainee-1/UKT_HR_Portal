"""
Google Drive offsite backup upload
=====================================
Optional, additive-only: local storage is always the primary backup copy
and the only thing Restore ever reads from. This just pushes a copy of an
already-written local backup file into a Google Drive folder, using a
Google Workspace service account (no interactive OAuth needed -the HR
admin shares a Shared Drive folder with the service account's email once,
from the Google Drive UI, and pastes the folder ID + JSON key here).

Requires the service account to have Content Manager access on a Shared
Drive (or a folder inside one) -a personal "My Drive" folder won't work,
since service accounts have no storage quota of their own outside a
Shared Drive.
"""

import json


class DriveError(Exception):
    pass


def _clean_google_error(exc: Exception) -> str:
    """googleapiclient's HttpError.__str__ dumps the full request URL plus a
    raw Python repr of the error-details list -technically complete but
    unreadable in a toast. Pull out just Google's actual human message."""
    content = getattr(exc, "content", None)
    if content:
        try:
            body = json.loads(content)
            message = body.get("error", {}).get("message")
            errors = body.get("error", {}).get("errors") or []
            reason = errors[0].get("reason") if errors else None
            if message:
                return f"{message}" + (f" (reason: {reason})" if reason else "")
        except (ValueError, AttributeError, KeyError, IndexError):
            pass
    return str(exc)


def _build_drive_service(service_account_json: str):
    try:
        from google.oauth2.service_account import Credentials
        from googleapiclient.discovery import build
    except ImportError:
        raise DriveError(
            "Google Drive support isn't installed on this server. "
            "Run: pip install google-api-python-client google-auth"
        )

    try:
        info = json.loads(service_account_json)
    except json.JSONDecodeError:
        raise DriveError("The service account key isn't valid JSON.")

    try:
        creds = Credentials.from_service_account_info(
            # The narrower "drive.file" scope only sees files the app itself
            # created (or that were granted via a Picker consent flow) -a
            # folder manually shared with the service account through the
            # Drive UI is invisible to it and returns a "File not found"
            # error even with Editor access. The full "drive" scope is
            # required to see manually-shared files/folders.
            info, scopes=["https://www.googleapis.com/auth/drive"]
        )
    except Exception as exc:
        raise DriveError(f"Could not load service account credentials: {exc}")

    return build("drive", "v3", credentials=creds, cache_discovery=False)


def test_drive_connection(folder_id: str, service_account_json: str) -> dict:
    """A lightweight round trip confirming the folder ID + key actually work
    together before relying on them during a real scheduled run."""
    try:
        service = _build_drive_service(service_account_json)
        folder = service.files().get(
            fileId=folder_id, fields="id,name,driveId", supportsAllDrives=True,
        ).execute()
    except DriveError as exc:
        return {"ok": False, "error": str(exc)}
    except Exception as exc:
        return {
            "ok": False,
            "error": (
                f"Could not access folder '{folder_id}': {_clean_google_error(exc)}. Check that "
                "the folder ID is correct and that the service account's email (client_email in "
                "the JSON key) has been added as a Content Manager on that Shared Drive folder."
            ),
        }

    result = {"ok": True, "folderName": folder.get("name")}
    if not folder.get("driveId"):
        # Connection works, but this folder is in someone's personal "My
        # Drive," not a Shared Drive -uploads will still fail once they
        # actually run, since service accounts have no storage quota of
        # their own outside a Shared Drive. Warn now, before that surprise.
        result["warning"] = (
            "This folder can be reached, but it's in a personal My Drive, not a Shared Drive. "
            "Backups uploaded here will likely fail with a storage-quota error, since service "
            "accounts have no storage of their own outside a Shared Drive. Create a real Shared "
            "Drive (Drive's left sidebar -> \"Shared drives\" -> New), add the service account as "
            "a Content Manager there, and use that folder's ID instead."
        )
    return result


def upload_to_drive(file_path: str, folder_id: str, service_account_json: str) -> dict:
    try:
        from googleapiclient.http import MediaFileUpload
    except ImportError:
        raise DriveError(
            "Google Drive support isn't installed on this server. "
            "Run: pip install google-api-python-client google-auth"
        )

    import os
    service = _build_drive_service(service_account_json)
    filename = os.path.basename(file_path)
    metadata = {"name": filename, "parents": [folder_id]}
    media = MediaFileUpload(file_path, mimetype="application/zip", resumable=True)

    try:
        created = service.files().create(
            body=metadata, media_body=media, fields="id,webViewLink",
            supportsAllDrives=True,
        ).execute()
    except Exception as exc:
        raise DriveError(f"Upload to Google Drive failed: {_clean_google_error(exc)}")

    return {"ok": True, "fileId": created.get("id"), "webViewLink": created.get("webViewLink")}
