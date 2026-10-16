/**
 * Text that may be thousands of characters with no spaces (base64 data URIs, JSON, RPC errors).
 * Short text renders inline. Long text shows a one-line preview; clicking it opens the full
 * value in a scrollable box instead of stretching the page.
 */
export function LongText({ text, max = 90, className = "" }: { text: string; max?: number; className?: string }) {
  if (text.length <= max) return <span className={`wrap ${className}`}>{text}</span>;
  return (
    <details className={`longtext ${className}`}>
      <summary title="Show the full value">
        {text.slice(0, max)}… <span className="muted">({text.length.toLocaleString()} chars)</span>
      </summary>
      <pre className="textbox">{text}</pre>
    </details>
  );
}
