"""
Report Center: a registry of declarative reports (see ``types.ReportSpec``) served by three
endpoints -- catalog, run, export -- with server-side Excel and PDF export.

    reporting/types.py        ReportSpec / ColumnSpec / FilterSpec / ReportResult
    reporting/filters.py      filter factories, parameter parsing, ReportContext
    reporting/registry.py     register() / get_spec()
    reporting/access.py       who may see a report
    reporting/runner.py       run a spec -> normalised payload (rows, totals, summary)
    reporting/export_xlsx.py  Excel writer
    reporting/export_pdf.py   PDF writer
    reporting/views.py        the HTTP endpoints
    reporting/definitions/    the reports themselves, one module per domain
"""
