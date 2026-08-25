/**
 * copy-text.ts — one clipboard write, shared by every surface that offers a
 * copy button.
 *
 * The async Clipboard API needs a secure context and a permission the browser
 * may refuse; the textarea + execCommand fallback still works where it does
 * not. Returns whether the text actually landed, so the caller can say so
 * rather than flashing a lying "Copied ✓".
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const helper = document.createElement("textarea");
      helper.value = text;
      helper.style.position = "fixed";
      helper.style.opacity = "0";
      document.body.appendChild(helper);
      helper.select();
      const ok = document.execCommand("copy");
      helper.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
