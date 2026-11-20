/**
 * 轻量 DOM 构建辅助
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Omit<HTMLElementTagNameMap[K], 'style' | 'dataset'>> & {
    class?: string;
    style?: string | CSSStyleDeclaration;
    dataset?: Record<string, string>;
  } = {},
  children: (Node | string | null | undefined)[] = [],
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v as string;
    else if (k === 'style' && typeof v === 'string') el.setAttribute('style', v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else {
      (el as unknown as Record<string, unknown>)[k] = v;
    }
  }
  for (const c of children) {
    if (c == null) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function mount(node: HTMLElement, children: (Node | string | null | undefined)[]): void {
  clear(node);
  for (const c of children) {
    if (c != null) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
}

export function label(text: string): HTMLLabelElement {
  return h('label', { textContent: text });
}
