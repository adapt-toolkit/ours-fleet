import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { api } from './api';

export function TerminalView({ roleId }: { roleId: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState('connecting');
  const [warning, setWarning] = useState('Terminal bytes are privileged and unredacted.');
  const socketRef = useRef<WebSocket | undefined>(undefined);
  useEffect(() => {
    const terminal = new Terminal({ convertEol: true, cursorBlink: true, scrollback: 5_000, fontSize: 13 });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host.current!); fit.fit();
    let leaseId = '';
    let disposed = false;
    void api.post<{ ticket: string }>('/api/v1/ws-tickets', { purpose: 'terminal', roleId }).then(({ ticket }) => {
      if (disposed) return;
      const socket = new WebSocket(`ws://${location.host}/api/v1/roles/${encodeURIComponent(roleId)}/terminal`, 'ours-fleet-terminal.v1');
      socket.binaryType = 'arraybuffer'; socketRef.current = socket;
      socket.onopen = () => socket.send(JSON.stringify({ type: 'hello', protocol: 1, ticket, cols: terminal.cols, rows: terminal.rows }));
      socket.onmessage = event => {
        if (typeof event.data === 'string') {
          const message = JSON.parse(event.data);
          if (message.type === 'ready') setMode(message.mode);
          if (message.type === 'lease.granted') { leaseId = message.leaseId; setMode('controlling'); }
          if (message.type === 'snapshot') { terminal.reset(); terminal.write(message.data); }
          if (message.type === 'resync.required') setWarning('Reconnecting from a fresh terminal snapshot…');
          if (message.type === 'error') setWarning(message.message ?? message.code);
        } else {
          const frame = new Uint8Array(event.data);
          if (frame[0] === 1) terminal.write(frame.slice(9));
        }
      };
      socket.onclose = event => { setMode('disconnected'); setWarning(event.reason || 'Terminal disconnected'); };
    }).catch(reason => setWarning((reason as Error).message));
    const data = terminal.onData(value => {
      const socket = socketRef.current;
      if (!leaseId || socket?.readyState !== WebSocket.OPEN) return;
      const bytes = new TextEncoder().encode(value);
      const frame = new Uint8Array(9 + bytes.length); frame[0] = 2; frame.set(bytes, 9);
      socket.send(frame);
    });
    const resize = new ResizeObserver(() => {
      fit.fit();
      const socket = socketRef.current;
      if (leaseId && socket?.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows, leaseId }));
    });
    resize.observe(host.current!);
    return () => {
      disposed = true; resize.disconnect(); data.dispose(); socketRef.current?.close(); terminal.dispose();
    };
  }, [roleId]);
  return <div className="terminal-panel panel">
    <div className="terminal-toolbar"><span className={`terminal-mode ${mode}`}>{mode}</span><span>{warning}</span>
      {mode !== 'controlling'
        ? <button onClick={() => socketRef.current?.send(JSON.stringify({ type: 'lease.request' }))}>Take control</button>
        : <button onClick={() => socketRef.current?.send(JSON.stringify({ type: 'lease.release' }))}>Release</button>}</div>
    <div className="terminal-host" ref={host} />
  </div>;
}
