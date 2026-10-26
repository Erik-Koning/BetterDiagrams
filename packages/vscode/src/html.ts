/**
 * html.ts — the webview's page: the built bundle and nothing else, under a
 * content security policy that lets in only that bundle's own files. Pure, so
 * the webview tests load exactly the page VS Code does.
 */
export interface WebviewPage {
  /** `webview.cspSource`: the origin the bundle's files are served from. */
  cspSource: string;
  scriptUri: string;
  styleUri: string;
  nonce: string;
  title: string;
}

const escape = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function webviewHtml({ cspSource, scriptUri, styleUri, nonce, title }: WebviewPage): string {
  const csp = [
    "default-src 'none'",
    // Pictures the editor draws for exports are data: and blob: URLs.
    `img-src ${cspSource} data: blob:`,
    // The editor sets inline styles and builds stylesheets for its exports.
    `style-src ${cspSource} 'unsafe-inline'`,
    `font-src ${cspSource} data:`,
    `script-src 'nonce-${nonce}'`,
    // An export is read back from its blob: URL to hand to the extension.
    "connect-src blob: data:",
  ].join("; ");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${escape(styleUri)}" />
    <title>${escape(title)}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" nonce="${nonce}" src="${escape(scriptUri)}"></script>
  </body>
</html>
`;
}
