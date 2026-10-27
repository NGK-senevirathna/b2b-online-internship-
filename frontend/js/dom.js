'use strict';

/**
 * Safe DOM helpers. Every piece of data reaches the page as a text node or a
 * plain attribute value, never as HTML, so API data cannot inject markup.
 */

const SAFE_HREF = /^(#|\/(?!\/))/;

/**
 * Appends children (strings, numbers, nodes, arrays) to a parent node.
 * @param {Node} parent Target node.
 * @param {unknown[]} children Values to append.
 * @returns {Node} The parent.
 */
export function append(parent, children) {
    for (const child of children) {
        if (child === null || child === undefined || child === false) continue;
        if (Array.isArray(child)) append(parent, child);
        else if (child instanceof Node) parent.appendChild(child);
        else parent.appendChild(document.createTextNode(String(child)));
    }
    return parent;
}

/**
 * Creates an element. Props: class, text, on (event map), dataset, any attribute.
 * Inline handlers, style attributes and non-local links are refused.
 * @param {string} tag Element name.
 * @param {object} [props] Attributes and options.
 * @param {...unknown} children Child content.
 * @returns {HTMLElement} New element.
 */
export function h(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
        if (value === undefined || value === null || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = String(value);
        else if (key === 'on') {
            for (const [name, handler] of Object.entries(value)) node.addEventListener(name, handler);
        } else if (key === 'dataset') Object.assign(node.dataset, value);
        else if (/^on/i.test(key) || key === 'style' || key === 'srcdoc') {
            throw new Error(`Attribute "${key}" is not allowed (strict CSP).`);
        } else if (key === 'href') {
            if (!SAFE_HREF.test(String(value))) throw new Error('Only local links are allowed.');
            node.setAttribute('href', String(value));
        } else if (key === 'value') node.value = String(value);
        else if (key === 'checked' || key === 'disabled' || key === 'selected' || key === 'required') node[key] = true;
        else node.setAttribute(key, value === true ? '' : String(value));
    }
    return append(node, children);
}

/**
 * Replaces all children of a node.
 * @param {Node} parent Node to refill.
 * @param {...unknown} children New content.
 * @returns {Node} The parent.
 */
export function replace(parent, ...children) {
    parent.replaceChildren();
    return append(parent, children);
}
