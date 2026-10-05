"""The MD portal's AI assistant: a read-only Gemini agent that answers questions about company data and shows how it
got there. Layout:

    tools_base.py   how an analytics module offers its figures as assistant tools (`tool(...)`, `ToolSpec`)
    registry.py     collects every module's TOOLS plus the generic tools into one table
    (more modules are added as the assistant is built: gemini client, query DSL, privacy, engine, jobs)

Read-only is enforced three ways: the tools only call analytics functions that read, they run inside
common.read_only_db() (the database refuses any write), and the assistant has no tool that changes anything.
"""
