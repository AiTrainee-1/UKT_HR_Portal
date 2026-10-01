import { Component, type ErrorInfo, type ReactNode } from "react";
import { useLocation } from "wouter";
import ServerError from "@/pages/ServerError";

type Props = { children: ReactNode; resetKey: string };
type State = { error: Error | null };

class Boundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Page crashed:", error, info.componentStack);
  }

  componentDidUpdate(prev: Props) {
    // Moving to another page gives it a fresh start.
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    if (this.state.error)
      return <ServerError error={this.state.error} onRetry={() => this.setState({ error: null })} />;
    return this.props.children;
  }
}

/** Shows the Server Error screen instead of a blank page when something below throws while rendering. */
export default function ErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <Boundary resetKey={location}>{children}</Boundary>;
}
