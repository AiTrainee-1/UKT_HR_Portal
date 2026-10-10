"""MD portal: page briefs (mounted at /api/md/brief/).

  GET <page id>    the headline figures and exceptions of the analytics module behind that MD page (api/md_portal/pages.py)
"""

from django.urls import path

from ..analytics import brief as brief_analytics
from ..common import md_get


@md_get
def page_brief(request, page):
    return brief_analytics.page_brief(page)


urlpatterns = [path("<str:page>", page_brief)]
