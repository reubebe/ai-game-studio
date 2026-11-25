import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Shown in the message so people know which part failed. */
  area: string;
  onHome: () => void;
}

/** Keeps one failing view from blanking the whole window. Saved work is unaffected: views never hold files open. */
export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`View "${this.props.area}" failed`, error, info.componentStack);
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="empty" role="alert" data-testid="view-error">
        <div className="stack" style={{ alignItems: "center", maxWidth: 560, textAlign: "center" }}>
          <h3>This view stopped working</h3>
          <p className="muted">The {this.props.area} view hit an error. Your project files were not changed. Unsaved edits in other documents are still in memory.</p>
          <pre className="console" style={{ maxWidth: 520, textAlign: "left", background: "var(--bg-1)", borderRadius: 6 }}>{error.message}</pre>
          <div className="row">
            <button type="button" className="btn" onClick={() => this.setState({ error: null })}>Try again</button>
            <button type="button" className="btn btn--primary" onClick={this.props.onHome}>Go to Home</button>
          </div>
        </div>
      </div>
    );
  }
}
