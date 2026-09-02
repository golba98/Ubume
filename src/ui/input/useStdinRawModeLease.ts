import { useEffect } from "react";
import { useStdin } from "ink";

/**
 * Hold one raw-mode reference for the lifetime of the mounted tree.
 *
 * Ink refcounts raw-mode consumers (useFocus / active useInput). When the last
 * consumer unmounts and a replacement mounts in the same commit — e.g. the
 * composer moving between AppShell and TranscriptShell on overlay exit — Ink
 * removes and re-adds its 'readable' stdin listener. Two such cycles in one
 * tick, combined with a raw 'data' listener (BottomComposer's key sniffer),
 * make Node/Bun streams switch stdin to flowing mode, after which 'readable'
 * never fires and Ink stops receiving input entirely (no keys, no Ctrl+C).
 * Keeping the count above zero at the root prevents the listener churn.
 */
export function useStdinRawModeLease(): void {
  const { isRawModeSupported, setRawMode } = useStdin();
  useEffect(() => {
    if (!isRawModeSupported) return;
    setRawMode(true);
    return () => setRawMode(false);
  }, [isRawModeSupported, setRawMode]);
}
