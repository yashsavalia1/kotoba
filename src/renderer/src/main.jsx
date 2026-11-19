import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './ui/App.jsx';
import './ui/theme.css';

// Without a boundary any render or effect error unmounts everything and leaves a blank window.
class Crash extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="boot" data-testid="crash">
        <div style={{ textAlign: 'center' }}>
          <p>Kotoba hit an error: {this.state.error.message}</p>
          <button className="btn" onClick={() => location.reload()}>Reload</button>
        </div>
      </div>
    );
  }
}

createRoot(document.getElementById('root')).render(
  <Crash>
    <App />
  </Crash>
);
