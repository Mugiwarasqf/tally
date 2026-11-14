import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { Empty } from './bits';

interface State { error: Error | null }

/**
 * Catches a render error inside one page so the shell (navigation, top bar) stays usable.
 * Without a boundary React unmounts the whole tree, which looks like a blank app.
 * The shell remounts this per route, so moving to another page clears the error.
 */
export class PageBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Page failed to render', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <Empty
        icon="WarningCircle"
        title="This page hit a snag"
        action={<button className="btn btn--primary" onClick={() => location.reload()}>Reload Tally</button>}
      >
        Your data is safe; nothing was changed. Try another page or reload. Details: {error.message}
      </Empty>
    );
  }
}
