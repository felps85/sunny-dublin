import React from "react";

type Props = {
  children: React.ReactNode;
};

type State = {
  hasError: boolean;
  message?: string;
};

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error.message };
  }

  override componentDidCatch(error: Error) {
    console.error("Sunny Dublin runtime error", error);
  }

  override render() {
    if (this.state.hasError) {
      return (
        <div className="appError">
          <h1>Sunny Dublin hit a runtime error</h1>
          <p>{this.state.message ?? "Unknown error"}</p>
          <p>Try refreshing the page. If it persists, the app now stays visible instead of showing a blank screen.</p>
        </div>
      );
    }

    return this.props.children;
  }
}
