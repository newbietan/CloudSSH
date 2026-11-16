/** First-party, fixed SVG geometry. No icon font/CDN, user markup, or animation. */
export type AssistantIcon = 'agent' | 'mcp';
const paths = {
  agent: [
    ['path', { d: 'M12 4H8a5 5 0 0 0-5 5v4a5 5 0 0 0 5 5h1l4 3v-3h3a5 5 0 0 0 5-5v-2' }],
    ['path', { d: 'M18 2l1.1 2.9L22 6l-2.9 1.1L18 10l-1.1-2.9L14 6l2.9-1.1L18 2Z' }],
    ['path', { d: 'M7.5 10h4M7.5 14h8' }],
  ],
  mcp: [
    ['circle', { cx: '5', cy: '12', r: '2.5' }],
    ['circle', { cx: '18', cy: '5', r: '2.5' }],
    ['circle', { cx: '18', cy: '19', r: '2.5' }],
    ['path', { d: 'M7.5 12H12M12 12V7a2 2 0 0 1 2-2h1.5M12 12v5a2 2 0 0 0 2 2h1.5' }],
  ],
} as const;

/** Only fixed internal constants are serialized; callers cannot supply attributes or markup. */
export function assistantIconMarkup(icon: AssistantIcon): string {
  const body = paths[icon]
    .map(
      ([tag, attributes]) =>
        `<${tag} ${Object.entries(attributes)
          .map(([key, value]) => `${key}="${value}"`)
          .join(' ')}/>`
    )
    .join('');
  return `<svg class="assistant-icon" data-assistant-glyph="${icon}" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}

export function createAssistantIcon(icon: AssistantIcon): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({
    class: 'assistant-icon',
    'data-assistant-glyph': icon,
    viewBox: '0 0 24 24',
    width: '24',
    height: '24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.7',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  }))
    svg.setAttribute(key, value);
  for (const [tag, attributes] of paths[icon]) {
    const child = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attributes)) child.setAttribute(key, value);
    svg.append(child);
  }
  return svg;
}

export function mountAssistantIcons(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-assistant-icon]').forEach((node) => {
    const icon = node.dataset.assistantIcon;
    if (icon === 'agent' || icon === 'mcp') node.replaceChildren(createAssistantIcon(icon));
  });
}
