"""URL table of the assistant, mounted at /api/md/assistant/ (md_portal/urls.py). Every view carries @require_md."""

from django.urls import path

from . import views

urlpatterns = [
    path("status", views.status),
    path("conversations", views.conversations),
    path("conversations/<int:pk>", views.conversation_detail),
    path("ask", views.ask),
    path("messages/<int:pk>", views.message_detail),
    path("messages/<int:pk>/cancel", views.cancel_message),
    path("transcribe", views.transcribe),
]
