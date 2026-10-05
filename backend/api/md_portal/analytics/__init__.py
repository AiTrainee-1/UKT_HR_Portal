"""Analytics functions of the MD portal, one module per page. Pure and read-only: they take a Period and a Scope
(common.py) and return a JSON-ready dict built with common.envelope(). The REST views (routes/) and the AI assistant's
tools (assistant/tools.py) both call them."""
