"""HR Analytics (/hr/analytics): hr_analytics/views.py."""

from django.urls import path

from .hr_analytics import views as v

urlpatterns = [
    path("hr-analytics/summary", v.summary),
    path("hr-analytics/category/<str:key>", v.category),
    path("hr-analytics/employee/<int:pk>", v.employee),
]
