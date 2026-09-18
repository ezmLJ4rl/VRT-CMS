import { Component } from 'react';
import VrtLogo from './VrtLogo';
import { LOGO_SIZE } from '../logoSize';
import { CHURCH_NAME } from '../i18n/common';

/**
 * Last-resort error boundary: a render crash anywhere in the tree shows a
 * friendly recovery screen instead of a blank page (the admin dashboard once
 * blanked this way on an undefined variable). Reload clears transient state;
 * for persistent crashes the church can still report the error.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Keep a console trace for debugging; the UI stays friendly on top.
    console.error('Unhandled render error:', error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-canvas px-4 py-10 text-center">
        <VrtLogo size={LOGO_SIZE.card} className="mx-auto" />
        {/* Every other screen that shows the mark names the church beside it
            (header, login card); this one is reached without any chrome at
            all, so the name is what tells the person looking at it which app
            just failed. */}
        <p className="mt-3 mb-5 font-display text-sm font-semibold tracking-wide text-ink-600">{CHURCH_NAME}</p>
        <h1 className="font-display text-xl font-semibold text-ink-900">{this.props.title}</h1>
        <p className="mt-2 max-w-sm text-sm text-ink-400">{this.props.message}</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="btn btn-primary btn-lg mt-6"
        >
          {this.props.reloadLabel}
        </button>
      </div>
    );
  }
}
