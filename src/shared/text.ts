/** Keep the start and end of long text; failure evidence in logs is usually near the end. */
export function clip(text: string, head: number, tail: number): string {
  if (text.length <= head + tail) return text;
  return `${text.slice(0, head)}\n... [${text.length - head - tail} chars omitted] ...\n${text.slice(-tail)}`;
}
