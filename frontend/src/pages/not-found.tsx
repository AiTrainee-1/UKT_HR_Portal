import { useLocation } from "wouter";
import { ArrowLeft, Home } from "lucide-react";
import { StatusActions, StatusButton, StatusScreen } from "@/components/status/StatusScreen";

export default function NotFound() {
  const [location] = useLocation();

  return (
    <StatusScreen
      tone="info"
      code="404"
      badge="Page not found"
      title="This page wandered off"
      description={
        <>
          We couldn't find <code>{location}</code>. The link may be out of date or mistyped, or the page may have moved.
        </>
      }
      details={[
        { label: "Address", value: location },
        { label: "Status", value: "404 · Not found", tone: "bad" },
        { label: "Time", value: new Date().toLocaleString("en-IN") },
      ]}
    >
      <StatusActions>
        <StatusButton href="/" icon={Home}>
          Take me home
        </StatusButton>
        <StatusButton variant="ghost" icon={ArrowLeft} onClick={() => window.history.back()}>
          Go back
        </StatusButton>
      </StatusActions>
    </StatusScreen>
  );
}
