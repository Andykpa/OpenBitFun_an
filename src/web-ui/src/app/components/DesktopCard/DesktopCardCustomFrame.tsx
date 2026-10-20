import React, { useEffect, useMemo, useRef, useState } from 'react';
import { widgetAppearanceAdapter } from '@/infrastructure/appearance/adapters/WidgetAppearanceAdapter';
import {
  createWidgetAppearanceFallbackCss,
  readWidgetAppearancePayload,
} from '@/tools/generative-widget/appearancePayload';

const FRAME_MESSAGE_SOURCE = 'openbitfun-desktop-card';
const HOST_MESSAGE_SOURCE = 'openbitfun-desktop-card-host';

export interface DesktopCardCustomPayload {
  data: unknown;
  card: { id: string; title: string; subtitle?: string };
  error?: string;
}

interface DesktopCardCustomFrameProps {
  html: string;
  title: string;
  payload: DesktopCardCustomPayload;
  onOpenLink: (url: string) => void;
}

// The widget runs in an opaque-origin sandbox and talks to the card only through this bridge.
const BRIDGE_SCRIPT = `(function () {
  var handlers = [];
  var latest = null;
  function deliver(handler) {
    try { handler(latest); } catch (error) { console.error(error); }
  }
  window.openbitfunCard = {
    onData: function (handler) {
      if (typeof handler !== 'function') return;
      handlers.push(handler);
      if (latest) deliver(handler);
    },
    openLink: function (url) {
      parent.postMessage({ source: '${FRAME_MESSAGE_SOURCE}', type: 'open-link', url: String(url) }, '*');
    }
  };
  window.addEventListener('message', function (event) {
    if (event.source !== parent) return;
    var message = event.data;
    if (!message || message.source !== '${HOST_MESSAGE_SOURCE}' || message.type !== 'data') return;
    latest = message.payload;
    handlers.forEach(deliver);
  });
  parent.postMessage({ source: '${FRAME_MESSAGE_SOURCE}', type: 'ready' }, '*');
})();`;

const WIDGET_CSS = `
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: transparent; overflow: auto; }
body {
  color: var(--openbitfun-color-content-primary);
  font-family: var(--openbitfun-type-body-sm-font-family);
  font-size: var(--openbitfun-type-label-md-font-size);
  line-height: var(--openbitfun-type-body-sm-line-height);
}
a { color: var(--openbitfun-color-accent-default); text-decoration: none; }
img, svg, canvas { max-width: 100%; height: auto; }
.openbitfun-card-stack { display: flex; flex-direction: column; gap: var(--openbitfun-space-2); }
.openbitfun-card-row { display: flex; align-items: center; justify-content: space-between; gap: var(--openbitfun-space-3); min-width: 0; }
.openbitfun-card-value {
  font-family: var(--openbitfun-type-heading-page-font-family);
  font-size: var(--openbitfun-type-heading-page-font-size);
  font-weight: var(--openbitfun-type-heading-page-font-weight);
  line-height: var(--openbitfun-type-heading-page-line-height);
  font-variant-numeric: tabular-nums;
}
.openbitfun-card-muted { color: var(--openbitfun-color-content-secondary); font-size: var(--openbitfun-type-body-sm-font-size); }
.openbitfun-card-good { color: var(--openbitfun-color-status-success-content); }
.openbitfun-card-bad { color: var(--openbitfun-color-status-danger-content); }
`;

function escapeStyleText(value: string): string {
  return value.replace(/<\/style/gi, '<\\/style');
}

function buildSrcDoc(html: string, themeVars: Record<string, string>): string {
  const themeCss = Object.entries(themeVars)
    .filter(([name, value]) => /^--[a-z0-9-]+$/i.test(name) && !/[;{}<>]/.test(value))
    .map(([name, value]) => `${name}: ${value};`)
    .join(' ');
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https:; font-src data:; media-src data: https:" />
<style>:root {
${createWidgetAppearanceFallbackCss()}
${escapeStyleText(themeCss)}
}
${WIDGET_CSS}</style>
<script>${BRIDGE_SCRIPT}</script>
</head>
<body>${html}</body>
</html>`;
}

export function DesktopCardCustomFrame({ html, title, payload, onOpenLink }: DesktopCardCustomFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const payloadRef = useRef(payload);
  const onOpenLinkRef = useRef(onOpenLink);
  const [themeVars, setThemeVars] = useState<Record<string, string>>(() => readWidgetAppearancePayload()?.vars ?? {});
  payloadRef.current = payload;
  onOpenLinkRef.current = onOpenLink;

  useEffect(() => widgetAppearanceAdapter.subscribe(() => {
    setThemeVars(readWidgetAppearancePayload()?.vars ?? {});
  }), []);

  const srcDoc = useMemo(() => buildSrcDoc(html, themeVars), [html, themeVars]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frameWindow = iframeRef.current?.contentWindow;
      if (!frameWindow || event.source !== frameWindow) return;
      const message = event.data as { source?: unknown; type?: unknown; url?: unknown } | null;
      if (!message || message.source !== FRAME_MESSAGE_SOURCE) return;
      if (message.type === 'ready') {
        frameWindow.postMessage({ source: HOST_MESSAGE_SOURCE, type: 'data', payload: payloadRef.current }, '*');
      } else if (message.type === 'open-link' && typeof message.url === 'string') {
        onOpenLinkRef.current(message.url);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    iframeRef.current?.contentWindow?.postMessage({ source: HOST_MESSAGE_SOURCE, type: 'data', payload }, '*');
  }, [payload]);

  return (
    <iframe
      ref={iframeRef}
      className="openbitfun-desktop-card__custom-frame"
      title={title}
      sandbox="allow-scripts"
      srcDoc={srcDoc}
    />
  );
}

export default React.memo(DesktopCardCustomFrame);
