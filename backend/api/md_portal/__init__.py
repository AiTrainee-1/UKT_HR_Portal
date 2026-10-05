"""The Managing Director (MD) portal: executive analytics and the read-only AI assistant.

Everything here is reachable only by the one account flagged `HRUser.is_md` (see auth.require_md); the rest of the
HR portal is untouched. Layout:

    pages.py       the MD pages (title, path, what each answers): the one list the assistant navigates with
    common.py      the analytics contract: periods, scope (branch / department / type), provenance, caching
    analytics/     one module per page: pure, read-only functions that return JSON (the pages and the assistant
                   both call them, so a number shown on a page and a number quoted by the assistant can never differ)
    views.py       thin REST views over the analytics functions, every one behind @require_md
    assistant/     the Gemini client, the read-only tools, explanation (XAI) building, privacy and the job runner
"""
