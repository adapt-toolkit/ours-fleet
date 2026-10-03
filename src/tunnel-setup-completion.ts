/** Keep the resumable record until both the QR and ordinary connection code were emitted. */
export async function completeTunnelSetup(effects: {
  link: () => Promise<unknown>;
  qr: (code: string) => Promise<string>;
  write: (text: string) => unknown;
  clear: () => void;
}): Promise<void> {
  try {
    const link = await effects.link();
    const code = Buffer.from(JSON.stringify(link)).toString('base64url');
    const qr = await effects.qr(code);
    effects.write('Tunnel configured. Scan the QR or paste this private single-use connection code into the App.\n' + qr + '\n' + code + '\n');
    effects.clear();
  } catch {
    throw Error('Tunnel is configured but its connection code could not be printed. Run ours-fleet setup-tunnel --resume to retry.');
  }
}
